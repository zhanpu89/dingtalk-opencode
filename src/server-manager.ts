import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
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

export interface ServerInstance {
  id: string;
  type: "default" | "project";
  projectPath?: string;
  port: number;
  baseUrl: string;
  status: string;
  startedAt: number;
}

export class ServerManager {
  // Default (main) opencode server
  private defaultHealthy = false;
  private defaultProc: ChildProcess | null = null;
  private readonly defaultBaseUrl: string;
  private readonly defaultPort: number;
  private readonly defaultHostname: string;

  // Project-specific opencode servers
  private projectServers = new Map<string, ProjectServerState>();
  private pendingStarts = new Map<string, Promise<ProjectServerState>>();
  private nextPort: number;

  constructor(private config: AppConfig) {
    const url = new URL(config.opencodeServerUrl);
    this.defaultBaseUrl = config.opencodeServerUrl;
    this.defaultPort = parseInt(url.port) || (url.protocol === "https:" ? 443 : 80);
    this.defaultHostname = url.hostname;
    this.nextPort = config.projectServerPortStart;
  }

  get isDefaultHealthy(): boolean {
    return this.defaultHealthy;
  }

  async start(): Promise<void> {
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
    // Don't wait for health — non-blocking
    this.defaultHealthy = true;
  }

  stop(): void {
    // Stop default server
    if (this.defaultProc && !this.defaultProc.killed) {
      this.defaultProc.kill("SIGTERM");
    }
    // Stop all project subprocesses
    for (const instance of this.projectServers.values()) {
      this.killProject(instance);
    }
    this.projectServers.clear();
  }

  // ── Project servers ──

  async startProject(project: ProjectConfig): Promise<string> {
    const existing = this.projectServers.get(project.id);

    if (existing && existing.status === "running") {
      existing.lastUsedAt = Date.now();
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

    // One ping to confirm
    try {
      const res = await fetch(`${instance.baseUrl}/global/health`);
      if (res.ok) {
        instance.status = "running";
        return { running: true, port: instance.port };
      }
    } catch {
      // unreachable
    }

    log.warn("project server unreachable", { projectId, port: instance.port });
    instance.status = "stopped";
    return { running: false, port: instance.port };
  }

  list(): ServerInstance[] {
    const instances: ServerInstance[] = [];
    // Default server
    instances.push({
      id: "default",
      type: "default",
      port: this.defaultPort,
      baseUrl: this.defaultBaseUrl,
      status: this.defaultHealthy ? "running" : "stopped",
      startedAt: Date.now(),
    });
    // Project servers
    for (const inst of this.projectServers.values()) {
      instances.push({
        id: inst.projectId,
        type: "project",
        projectPath: inst.projectPath,
        port: inst.port,
        baseUrl: inst.baseUrl,
        status: inst.status,
        startedAt: inst.startedAt,
      });
    }
    return instances;
  }

  get(projectId: string): ServerInstance | undefined {
    const inst = this.projectServers.get(projectId);
    if (!inst) return undefined;
    return {
      id: inst.projectId,
      type: "project",
      projectPath: inst.projectPath,
      port: inst.port,
      baseUrl: inst.baseUrl,
      status: inst.status,
      startedAt: inst.startedAt,
    };
  }

  disposeProject(projectId: string): void {
    const instance = this.projectServers.get(projectId);
    if (instance) {
      this.killProject(instance);
      this.projectServers.delete(projectId);
    }
  }

  stopAllProjects(): void {
    for (const instance of this.projectServers.values()) {
      this.killProject(instance);
    }
  }

  // ── Server lifecycle ──

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
    });
    this.projectServers.set(project.id, instance);

    // Poll health for up to 30s
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${baseUrl}/global/health`);
        if (res.ok) {
          instance.status = "running";
          return instance;
        }
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Timeout — kill process, mark failed
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
