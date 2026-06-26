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
  /** 标记是否为主动停止（非意外退出），主动停止不触发自动重启 */
  intentionalStop?: boolean;
  /** 意外退出自动重启次数（防止崩溃循环） */
  restartCount?: number;
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

  // Idle reaper
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: AppConfig) {
    const url = new URL(config.opencodeServerUrl);
    this.defaultBaseUrl = config.opencodeServerUrl;
    this.defaultPort = parseInt(url.port) || (url.protocol === "https:" ? 443 : 80);
    this.defaultHostname = url.hostname;
    this.nextPort = config.projectServerPortStart;
    this.startIdleReaper();
  }

  /**
   * 空闲回收器：定期扫描所有项目服务，超过 PROJECT_SERVER_IDLE_MS 未使用的自动释放
   */
  private startIdleReaper(): void {
    const idleMs = this.config.projectServerIdleMs;
    if (idleMs <= 0) return; // 0 或负数表示不回收
    this.reaperTimer = setInterval(() => {
      const now = Date.now();
      for (const [projectId, instance] of this.projectServers) {
        if (instance.status !== "running") continue;
        const idle = now - instance.lastUsedAt;
        if (idle >= idleMs) {
          log.info("recycling idle project server", {
            projectId,
            idleMs: idle,
            thresholdMs: idleMs,
          });
          this.disposeProject(projectId);
        }
      }
    }, Math.min(idleMs, 60_000)); // 每分钟扫一次，但不大于阈值
  }

  private stopIdleReaper(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
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
    this.stopIdleReaper();
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
      this.killProject(instance);  // killProject 内部会设 intentionalStop = true
      this.projectServers.delete(projectId);
    }
  }

  /**
   * 回收项目服务端口：杀死旧进程，重启新实例。
   * 返回新实例的 baseUrl。
   */
  async recycleProject(project: ProjectConfig): Promise<string> {
    log.info("recycling project server", { projectId: project.id, path: project.path });
    const existing = this.projectServers.get(project.id);
    if (existing) {
      this.killProject(existing);
      this.projectServers.delete(project.id);
      // 等待端口释放
      await new Promise((r) => setTimeout(r, 1000));
    }
    return this.startProject(project);
  }

  stopAllProjects(): void {
    for (const instance of this.projectServers.values()) {
      this.killProject(instance);
    }
    this.projectServers.clear();
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
      stdio: ["pipe", "ignore", "ignore"],
      env: {
        ...process.env,
        // 防止 git pull 等命令因缺少 credential 而挂起等待输入
        GIT_TERMINAL_PROMPT: "0",
        // 抑制交互式授权弹窗（如 debconf / 首次启动向导）
        DEBIAN_FRONTEND: "noninteractive",
        CI: "true",
      },
    });
    // 立即关闭 stdin，防止子进程因交互式输入（权限确认/git 密码等）挂起
    child.stdin?.end();

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
    child.on("exit", (code, signal) => {
      const uptimeMs = Date.now() - instance.startedAt;
      instance.pid = undefined;
      instance.status = "stopped";

      if (instance.intentionalStop) {
        log.info("project server stopped intentionally", { projectId: project.id, uptimeMs });
        return;
      }

      // ── 意外退出 → 自动重启（最多 3 次，防止崩溃循环） ──
      log.error("project server exited UNEXPECTEDLY, will restart", {
        projectId: project.id,
        code,
        signal,
        uptimeMs,
        restartCount: instance.restartCount,
      });
      instance.restartCount = (instance.restartCount ?? 0) + 1;

      if (instance.restartCount > 3) {
        log.error("project server exceeded max restarts, giving up", { projectId: project.id });
        return;
      }

      // 延迟 2s 后自动重启（等端口释放）
      setTimeout(() => {
        // 检查是否已被主动清理（如 stopAllProjects）
        if (this.projectServers.get(project.id) !== instance) return;
        log.info("auto-restarting project server", { projectId: project.id, attempt: instance.restartCount });
        this.bootProject(project).then(() => {
          log.info("project server auto-restarted successfully", { projectId: project.id });
        }).catch((err) => {
          log.error("project server auto-restart failed", { projectId: project.id, error: String(err) });
        });
      }, 2000);
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
    instance.intentionalStop = true;
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
