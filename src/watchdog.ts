import { Logger } from "./logger.js";
import type { OpenCodeClient } from "./opencode.js";

const log = new Logger("Watchdog");

export type WatchdogState = "running" | "restart" | "server_down";

export interface WatchdogOptions {
  checkIntervalMs: number;
  maxHealthFailures: number;
}

const defaultOptions: WatchdogOptions = {
  checkIntervalMs: 60_000,
  maxHealthFailures: 3,
};

export class Watchdog {
  private _state: WatchdogState = "running";
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveHealthFailures = 0;
  private criticalAbort: AbortController | null = null;

  constructor(
    private opencode: OpenCodeClient,
    private sessionId: string,
    private options: WatchdogOptions = defaultOptions,
  ) {}

  get state(): WatchdogState {
    return this._state;
  }

  /**
   * 注入外部 AbortController，当看门狗确认服务不可用（server_down）或
   * 会话已消失（restart）时主动中断正在进行的 sendMessage。
   * 瞬态健康检查波动不会触发中断，仅状态确认变更后触发。
   */
  setCriticalAbort(ctrl: AbortController): void {
    this.criticalAbort = ctrl;
  }

  start(): void {
    this.timer = setInterval(() => {
      // 并发执行，防止 checkSession 阻塞 checkHealth
      this.checkHealth();
      this.checkSession();
    }, this.options.checkIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private triggerCriticalAbort(): void {
    if (this.criticalAbort && !this.criticalAbort.signal.aborted) {
      log.info("watchdog aborting in-flight message", { state: this._state });
      this.criticalAbort.abort();
    }
  }

  private async checkHealth(): Promise<void> {
    try {
      const healthy = await this.opencode.quickHealth();
      if (healthy) {
        this.consecutiveHealthFailures = 0;
      } else {
        this.consecutiveHealthFailures++;
        log.warn("OpenCode health check failed", {
          consecutive: this.consecutiveHealthFailures,
          max: this.options.maxHealthFailures,
        });
        if (this.consecutiveHealthFailures >= this.options.maxHealthFailures) {
          log.error("OpenCode server is down (detected by watchdog)");
          this._state = "server_down";
          this.triggerCriticalAbort();
        }
      }
    } catch (err) {
      this.consecutiveHealthFailures++;
      log.warn("OpenCode health check error", {
        consecutive: this.consecutiveHealthFailures,
        error: String(err),
      });
      if (this.consecutiveHealthFailures >= this.options.maxHealthFailures) {
        log.error("OpenCode server unreachable (detected by watchdog)");
        this._state = "server_down";
        this.triggerCriticalAbort();
      }
    }
  }

  private async checkSession(): Promise<void> {
    try {
      // 带超时的 session 检查：防止项目服务器无响应时阻塞看门狗（最长 10min）
      const exists = await Promise.race([
        this.opencode.sessionExists(this.sessionId),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error("session check timeout")), 15_000),
        ),
      ]);
      if (exists === false) {
        log.warn("session vanished from server", {
          sessionId: this.sessionId.slice(0, 8),
        });
        this._state = "restart";
        this.triggerCriticalAbort();
      }
    } catch {
      // 超时或 API 错误：静默忽略，不误报 restart，由 checkHealth 兜底
    }
  }
}
