import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import type { AppConfig } from "./config.js";
import type { ProjectConfig } from "./project-registry.js";
import { Logger } from "./logger.js";

const log = new Logger("ProjectServerManager");

export interface ProjectServerInstance {
  projectId: string;
  projectPath: string;
  port: number;
  baseUrl: string;
  process?: ChildProcess;
  pid?: number;
  startedAt: number;
  lastUsedAt: number;
  status: "starting" | "running" | "failed" | "stopped";
}

interface PersistedProjectServer {
  projectId: string;
  projectPath: string;
  port: number;
  baseUrl: string;
  pid?: number;
  startedAt: number;
  lastUsedAt: number;
  status: "running" | "stopped";
}

export class ProjectServerManager {
  private instances = new Map<string, ProjectServerInstance>();
  private starting = new Map<string, Promise<ProjectServerInstance>>();
  private nextPort: number;
  private statePath: string;

  constructor(private config: AppConfig) {
    this.nextPort = config.projectServerPortStart;
    this.statePath = path.join(config.dataDir, "project-servers.json");
    this.loadState();
  }

  list(): ProjectServerInstance[] {
    return [...this.instances.values()];
  }

  get(projectId: string): ProjectServerInstance | undefined {
    return this.instances.get(projectId);
  }

  async getHealthy(projectId: string): Promise<ProjectServerInstance | undefined> {
    const instance = this.instances.get(projectId);
    if (!instance) return undefined;

    if (await this.isHealthy(instance.baseUrl)) {
      instance.status = "running";
      this.persistState();
      return instance;
    }

    instance.status = "stopped";
    this.persistState();
    return instance;
  }

  async ensureStarted(project: ProjectConfig): Promise<ProjectServerInstance> {
    const existing = this.instances.get(project.id);
    if (existing?.status === "running" && await this.isHealthy(existing.baseUrl)) {
      existing.lastUsedAt = Date.now();
      this.persistState();
      return existing;
    }

    const pending = this.starting.get(project.id);
    if (pending) return pending;

    const promise = this.startInstance(project);
    this.starting.set(project.id, promise);
    try {
      return await promise;
    } finally {
      this.starting.delete(project.id);
    }
  }

  private async startInstance(project: ProjectConfig): Promise<ProjectServerInstance> {
    const existing = this.instances.get(project.id);
    if (existing) {
      this.stopInstance(existing);
    }

    const port = await this.allocatePort();
    const baseUrl = `http://${this.config.projectServerHostname}:${port}`;
    log.info("starting project opencode server", {
      projectId: project.id,
      path: project.path,
      port,
    });

    const child = spawn("opencode", ["serve", "--port", String(port), "--hostname", this.config.projectServerHostname], {
      cwd: project.path,
      stdio: "ignore",
      env: process.env,
    });

    const instance: ProjectServerInstance = {
      projectId: project.id,
      projectPath: project.path,
      port,
      baseUrl,
      process: child,
      pid: child.pid,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      status: "starting",
    };

    child.on("exit", () => {
      instance.status = "stopped";
      this.persistState();
    });

    this.instances.set(project.id, instance);
    this.persistState();

    try {
      await this.waitForHealthy(baseUrl);
      instance.status = "running";
      this.persistState();
      return instance;
    } catch (err) {
      instance.status = "failed";
      this.stopInstance(instance);
      throw err;
    }
  }

  stopAll(): void {
    for (const instance of this.instances.values()) {
      this.stopInstance(instance);
    }
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.statePath)) return;
      const raw = fs.readFileSync(this.statePath, "utf-8");
      const data = JSON.parse(raw) as PersistedProjectServer[];
      let maxPort = this.config.projectServerPortStart - 1;

      for (const item of data) {
        this.instances.set(item.projectId, {
          projectId: item.projectId,
          projectPath: item.projectPath,
          port: item.port,
          baseUrl: item.baseUrl,
          pid: item.pid,
          startedAt: item.startedAt,
          lastUsedAt: item.lastUsedAt,
          status: item.status,
        });
        maxPort = Math.max(maxPort, item.port);
      }

      this.nextPort = Math.max(this.nextPort, maxPort + 1);
      log.info("project server state loaded", { entries: this.instances.size });
    } catch (err) {
      log.error("failed to load project server state", { error: String(err) });
    }
  }

  private persistState(): void {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      const data: PersistedProjectServer[] = [...this.instances.values()]
        .filter((instance) => instance.status === "running")
        .map((instance) => ({
          projectId: instance.projectId,
          projectPath: instance.projectPath,
          port: instance.port,
          baseUrl: instance.baseUrl,
          pid: instance.pid,
          startedAt: instance.startedAt,
          lastUsedAt: instance.lastUsedAt,
          status: "running",
        }));
      fs.writeFileSync(this.statePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      log.error("failed to save project server state", { error: String(err) });
    }
  }

  private stopInstance(instance: ProjectServerInstance): void {
    try {
      if (instance.process && !instance.process.killed) {
        instance.process.kill("SIGTERM");
      } else if (instance.pid) {
        process.kill(instance.pid, "SIGTERM");
      } else {
        for (const pid of this.findPidsByPort(instance.port)) {
          process.kill(pid, "SIGTERM");
        }
      }
    } catch (err) {
      log.warn("failed to stop project opencode server", {
        projectId: instance.projectId,
        pid: instance.pid,
        error: String(err),
      });
    }
    instance.status = "stopped";
    this.persistState();
  }

  private findPidsByPort(port: number): number[] {
    const inodes = new Set<string>();
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      try {
        const lines = fs.readFileSync(file, "utf-8").trim().split("\n").slice(1);
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          const local = parts[1];
          const state = parts[3];
          const inode = parts[9];
          const localPort = parseInt(local.split(":")[1], 16);
          if (localPort === port && state === "0A") inodes.add(inode);
        }
      } catch {}
    }

    const pids = new Set<number>();
    try {
      for (const entry of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        const fdDir = `/proc/${entry}/fd`;
        try {
          for (const fd of fs.readdirSync(fdDir)) {
            const link = fs.readlinkSync(path.join(fdDir, fd));
            const match = link.match(/^socket:\[(\d+)\]$/);
            if (match && inodes.has(match[1])) pids.add(Number(entry));
          }
        } catch {}
      }
    } catch {}
    return [...pids];
  }

  private async allocatePort(): Promise<number> {
    for (let i = 0; i < 200; i++) {
      const port = this.nextPort++;
      if (await this.isPortFree(port)) return port;
    }
    throw new Error("no free project server port available");
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

  private async waitForHealthy(baseUrl: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await this.isHealthy(baseUrl)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`project opencode server health check timeout: ${baseUrl}`);
  }

  private async isHealthy(baseUrl: string): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl}/global/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
