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

  constructor(
    private opencode: OpenCodeClient,
    private sessionId: string,
    private options: WatchdogOptions = defaultOptions,
  ) {}

  get state(): WatchdogState {
    return this._state;
  }

  start(): void {
    this.timer = setInterval(() => {
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
      }
    }
  }

  private async checkSession(): Promise<void> {
    try {
      const exists = await this.opencode.sessionExists(this.sessionId);
      if (exists === false) {
        log.warn("session vanished from server", {
          sessionId: this.sessionId.slice(0, 8),
        });
        this._state = "restart";
      }
    } catch {
      // ignore
    }
  }
}
