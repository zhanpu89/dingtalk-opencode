import { describe, it, expect, beforeEach, vi } from "vitest";
import { Watchdog } from "../watchdog.js";

vi.mock("../logger.js", () => ({
  Logger: class {
    info = vi.fn();
    error = vi.fn();
    warn = vi.fn();
    debug = vi.fn();
  },
}));

describe("Watchdog", () => {
  let abortController: AbortController;
  let mockOpencode: { health: ReturnType<typeof vi.fn>; sessionExists: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    abortController = new AbortController();
    mockOpencode = {
      health: vi.fn(),
      sessionExists: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("TC-MSG-UNIT-014 | 连续 3 次 health 失败触发 server_down", async () => {
    mockOpencode.health.mockResolvedValue(false);
    const watchdog = new Watchdog(mockOpencode as any, "sid", abortController, {
      checkIntervalMs: 1000,
      maxHealthFailures: 3,
    });
    watchdog.start();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(watchdog.state).toBe("server_down");
    expect(abortController.signal.aborted).toBe(true);
    watchdog.stop();
  });

  it("TC-MSG-UNIT-015 | session 消失触发 restart", async () => {
    mockOpencode.health.mockResolvedValue(true);
    mockOpencode.sessionExists.mockResolvedValue(false);
    const watchdog = new Watchdog(mockOpencode as any, "sid", abortController, {
      checkIntervalMs: 1000,
      maxHealthFailures: 3,
    });
    watchdog.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(watchdog.state).toBe("restart");
    expect(abortController.signal.aborted).toBe(true);
    watchdog.stop();
  });

  it("health 正常时保持 running", async () => {
    mockOpencode.health.mockResolvedValue(true);
    mockOpencode.sessionExists.mockResolvedValue(true);
    const watchdog = new Watchdog(mockOpencode as any, "sid", abortController, {
      checkIntervalMs: 1000,
      maxHealthFailures: 3,
    });
    watchdog.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(watchdog.state).toBe("running");
    watchdog.stop();
  });

  it("stop 后停止检查", async () => {
    mockOpencode.health.mockResolvedValue(false);
    const watchdog = new Watchdog(mockOpencode as any, "sid", abortController, {
      checkIntervalMs: 1000,
      maxHealthFailures: 3,
    });
    watchdog.start();
    watchdog.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(watchdog.state).toBe("running");
  });
});
