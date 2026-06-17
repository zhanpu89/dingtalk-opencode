import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { AppConfig } from "./config.js";
import type { ProjectConfig } from "./project-registry.js";
import { Logger } from "./logger.js";

const log = new Logger("ServerManager");

interface ProjectServerState {
  projectId: string;
  projectPath: string;
  port: number;
  baseUrl: string;
  pid?: number;
  startedAt: number;
  lastUsedAt: number;
  status: "starting" | "running" | "failed" | "stopped";
}

interface PersistedServer {
  projectId: string;
  projectPath: string;
  port: number;
  baseUrl: string;
  pid?: number;
  startedAt: number;
  lastUsedAt: number;
}

export class ServerManager {
  // Default (main) opencode server
  private defaultHealthy = false;
  private defaultProc: ChildProcess | null = null;
  private defaultFailures = 0;
  private readonly defaultBaseUrl: string;
  private readonly defaultPort: number;
  private readonly defaultHostname: string;

  // Project-specific opencode servers
  private projectServers = new Map<string, ProjectServerState>();
  private pendingStarts = new Map<string, Promise<ProjectServerState>>();
  private nextPort: number;

  // Background health monitor
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private readonly checkIntervalMs = 30_000;
  private readonly healthTimeoutMs = 10_000;
  private readonly maxFailures = 3;

  constructor(private config: AppConfig) {
    const url = new URL(config.opencodeServerUrl);
    this.defaultBaseUrl = config.opencodeServerUrl;
    this.defaultPort = parseInt(url.port) || (url.protocol === "https:" ? 443 : 80);
    this.defaultHostname = url.hostname;
    this.nextPort = config.projectServerPortStart;
    this.loadState();
  }

  get isDefaultHealthy(): boolean {
    return this.defaultHealthy;
  }

  async start(): Promise<void> {
    await this.checkDefault();
    this.healthTimer = setInterval(() => void this.checkAll(), this.checkIntervalMs);
    log.info("server health monitor started", { interval: this.checkIntervalMs });
  }

  stop(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    this.stopAllProjects();
  }

  // ── Default server ──

  ensureDefault(): Promise<string> {
    return this.defaultHealthy
      ? Promise.resolve(this.defaultBaseUrl)
      : this.restartDefault().then(() => this.defaultBaseUrl);
  }

  // ── Project servers ──

  async startProject(project: ProjectConfig): Promise<string> {
    const existing = this.projectServers.get(project.id);

    if (existing && (await this.ping(existing.baseUrl))) {
      existing.status = "running";
      existing.lastUsedAt = Date.now();
      this.saveState();
      return existing.baseUrl;
    }

    if (existing) {
      this.killProject(existing);
    }

    const pending = this.pendingStarts.get(project.id);
    if (pending) return (await pending).baseUrl;

    const promise = this.bootProject(project);
    this.pendingStarts.set(project.id, promise);
    try {
      const instance = await promise;
      return instance.baseUrl;
    } finally {
      this.pendingStarts.delete(project.id);
    }
  }

  async checkProject(projectId: string): Promise<{ running: boolean; port?: number }> {
    const instance = this.projectServers.get(projectId);
    if (!instance) return { running: false };

    if (await this.ping(instance.baseUrl)) {
      instance.status = "running";
      this.saveState();
      return { running: true, port: instance.port };
    }

    log.warn("project server unreachable", { projectId, port: instance.port });
    instance.status = "stopped";
    this.saveState();
    return { running: false, port: instance.port };
  }

  stopAllProjects(): void {
    for (const instance of this.projectServers.values()) {
      this.killProject(instance);
    }
  }

  // ── Background health checks ──

  private async checkAll(): Promise<void> {
    await this.checkDefault();
    for (const [projectId, inst] of this.projectServers) {
      if (inst.status !== "running") continue;
      if (!(await this.ping(inst.baseUrl))) {
        log.warn("project server became unhealthy", { projectId, port: inst.port });
        inst.status = "stopped";
        this.saveState();
      }
    }
  }

  private async checkDefault(): Promise<void> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.healthTimeoutMs);
      const res = await fetch(`${this.defaultBaseUrl}/global/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`status ${res.status}`);
      if (!this.defaultHealthy) log.info("default server health restored");
      this.defaultHealthy = true;
      this.defaultFailures = 0;
    } catch {
      this.defaultFailures++;
      log.warn("default server health check failed", {
        consecutive: this.defaultFailures,
        max: this.maxFailures,
      });
      if (this.defaultFailures >= this.maxFailures) {
        this.defaultHealthy = false;
        this.defaultFailures = 0;
        log.error("default server unreachable, attempting restart");
        void this.restartDefault();
      }
    }
  }

  private async ping(url: string): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.healthTimeoutMs);
      const res = await fetch(`${url}/global/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Server lifecycle ──

  private async restartDefault(): Promise<void> {
    if (this.defaultProc && !this.defaultProc.killed) {
      this.defaultProc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 2000));
      if (!this.defaultProc.killed) {
        this.defaultProc.kill("SIGKILL");
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    try {
      log.info("starting default server", { port: this.defaultPort });
      const child = spawn("opencode", ["serve", "--port", String(this.defaultPort), "--hostname", this.defaultHostname], {
        cwd: process.cwd(),
        stdio: "ignore",
        env: { ...process.env },
      });
      this.defaultProc = child;
      child.on("exit", (code) => {
        log.warn("default server exited", { code });
        this.defaultHealthy = false;
      });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (await this.ping(this.defaultBaseUrl)) {
          this.defaultHealthy = true;
          this.defaultFailures = 0;
          log.info("default server restarted successfully");
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      log.error("default server restart timed out");
    } catch (err) {
      log.error("failed to restart default server", { error: String(err) });
    }
  }

  private async bootProject(project: ProjectConfig): Promise<ProjectServerState> {
    const existing = this.projectServers.get(project.id);
    if (existing) this.killProject(existing);

    const port =
      existing && (await this.isPortFree(existing.port))
        ? existing.port
        : await this.allocatePort();
    const baseUrl = `http://${this.config.projectServerHostname}:${port}`;

    log.info("starting project server", { projectId: project.id, port });
    const child = spawn("opencode", ["serve", "--port", String(port), "--hostname", this.config.projectServerHostname], {
      cwd: project.path,
      stdio: "ignore",
      env: { ...process.env },
    });

    const instance: ProjectServerState = {
      projectId: project.id,
      projectPath: project.path,
      port,
      baseUrl,
      pid: child.pid,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      status: "starting",
    };
    child.on("exit", () => {
      instance.status = "stopped";
      this.saveState();
    });
    this.projectServers.set(project.id, instance);
    this.saveState();

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await this.ping(baseUrl)) {
        instance.status = "running";
        this.saveState();
        return instance;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    instance.status = "failed";
    this.killProject(instance);
    throw new Error(`project server startup timeout: ${baseUrl}`);
  }

  private killProject(instance: ProjectServerState): void {
    try {
      if (instance.pid) process.kill(instance.pid, "SIGTERM");
    } catch {
      /* already dead */
    }
    instance.status = "stopped";
    this.saveState();
  }

  // ── State persistence ──

  private statePath = path.join("data", "project-servers.json");

  private saveState(): void {
    try {
      const data: PersistedServer[] = [];
      for (const inst of this.projectServers.values()) {
        if (inst.status !== "running") continue;
        data.push({
          projectId: inst.projectId,
          projectPath: inst.projectPath,
          port: inst.port,
          baseUrl: inst.baseUrl,
          pid: inst.pid,
          startedAt: inst.startedAt,
          lastUsedAt: inst.lastUsedAt,
        });
      }
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(data, null, 2));
    } catch (err) {
      log.error("failed to save server state", { error: String(err) });
    }
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.statePath)) return;
      const raw = fs.readFileSync(this.statePath, "utf-8");
      const data = JSON.parse(raw) as PersistedServer[];
      let maxPort = this.config.projectServerPortStart - 1;
      for (const item of data) {
        this.projectServers.set(item.projectId, { ...item, status: "stopped" });
        maxPort = Math.max(maxPort, item.port);
      }
      this.nextPort = Math.max(this.nextPort, maxPort + 1);
      log.info("server state loaded", { entries: this.projectServers.size });
    } catch (err) {
      log.error("failed to load server state", { error: String(err) });
    }
  }

  // ── Port allocation ──

  private async allocatePort(): Promise<number> {
    for (let i = 0; i < 200; i++) {
      const port = this.nextPort++;
      if (await this.isPortFree(port)) return port;
    }
    throw new Error("no free port available");
  }

  private isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port, this.config.projectServerHostname);
    });
  }
}
