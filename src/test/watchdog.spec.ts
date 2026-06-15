import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Watchdog } from '../watchdog.js';
import type { OpenCodeClient } from '../opencode.js';

function createMockOpenCodeClient(): jest.Mocked<OpenCodeClient> {
  return {
    health: vi.fn(),
    sessionExists: vi.fn(),
  } as unknown as jest.Mocked<OpenCodeClient>;
}

describe('Watchdog', () => {
  let mockClient: ReturnType<typeof createMockOpenCodeClient>;
  let abortController: AbortController;
  let watchdog: Watchdog;

  beforeEach(() => {
    vi.useFakeTimers();
    mockClient = createMockOpenCodeClient();
    abortController = new AbortController();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('TC-WDOG-UNIT-001 | 健康检查正常——consecutiveHealthFailures 归零', async () => {
    mockClient.health.mockResolvedValue(true);
    watchdog = new Watchdog(mockClient, 'sid-1', abortController, { checkIntervalMs: 1000, maxHealthFailures: 3 });
    watchdog.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect((watchdog as any).consecutiveHealthFailures).toBe(0);
    expect(watchdog.state).toBe('running');
    watchdog.stop();
  });

  it('TC-WDOG-UNIT-002 | 健康检查连续失败 < 3——递增计数，state 不变', async () => {
    mockClient.health.mockResolvedValue(false);
    watchdog = new Watchdog(mockClient, 'sid-1', abortController, { checkIntervalMs: 1000, maxHealthFailures: 3 });
    watchdog.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect((watchdog as any).consecutiveHealthFailures).toBe(1);
    expect(watchdog.state).toBe('running');
    await vi.advanceTimersByTimeAsync(1000);
    expect((watchdog as any).consecutiveHealthFailures).toBe(2);
    expect(watchdog.state).toBe('running');
    watchdog.stop();
  });

  it('TC-WDOG-UNIT-003 | 健康检查连续失败 = 3——state=server_down，abort 触发', async () => {
    mockClient.health.mockResolvedValue(false);
    const abortSpy = vi.spyOn(abortController, 'abort');
    watchdog = new Watchdog(mockClient, 'sid-1', abortController, { checkIntervalMs: 1000, maxHealthFailures: 3 });
    watchdog.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect((watchdog as any).consecutiveHealthFailures).toBe(3);
    expect(watchdog.state).toBe('server_down');
    expect(abortSpy).toHaveBeenCalled();
    watchdog.stop();
  });

  it('TC-WDOG-UNIT-004 | 健康检查异常（throw）计入连续失败计数', async () => {
    mockClient.health.mockRejectedValue(new Error('network error'));
    watchdog = new Watchdog(mockClient, 'sid-1', abortController, { checkIntervalMs: 1000, maxHealthFailures: 3 });
    watchdog.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect((watchdog as any).consecutiveHealthFailures).toBe(1);
    expect(watchdog.state).toBe('running');
    watchdog.stop();
  });

  it('TC-WDOG-UNIT-005 | session 存在——state 不变', async () => {
    mockClient.health.mockResolvedValue(true);
    mockClient.sessionExists.mockResolvedValue(true);
    watchdog = new Watchdog(mockClient, 'sid-1', abortController, { checkIntervalMs: 1000, maxHealthFailures: 3 });
    watchdog.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(watchdog.state).toBe('running');
    expect(abortController.signal.aborted).toBe(false);
    watchdog.stop();
  });

  it('TC-WDOG-UNIT-006 | session 消失——state=restart，abort 触发', async () => {
    mockClient.health.mockResolvedValue(true);
    mockClient.sessionExists.mockResolvedValue(false);
    const abortSpy = vi.spyOn(abortController, 'abort');
    watchdog = new Watchdog(mockClient, 'sid-1', abortController, { checkIntervalMs: 1000, maxHealthFailures: 3 });
    watchdog.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(watchdog.state).toBe('restart');
    expect(abortSpy).toHaveBeenCalled();
    watchdog.stop();
  });

  it('TC-WDOG-UNIT-007 | sessionExists 返回 null——跳过本轮，state 不变', async () => {
    mockClient.health.mockResolvedValue(true);
    mockClient.sessionExists.mockResolvedValue(null);
    watchdog = new Watchdog(mockClient, 'sid-1', abortController, { checkIntervalMs: 1000, maxHealthFailures: 3 });
    watchdog.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(watchdog.state).toBe('running');
    expect(abortController.signal.aborted).toBe(false);
    watchdog.stop();
  });

  it('TC-WDOG-UNIT-008 | checkSession 抛异常——被 catch 吞掉', async () => {
    mockClient.health.mockResolvedValue(true);
    mockClient.sessionExists.mockRejectedValue(new Error('API error'));
    watchdog = new Watchdog(mockClient, 'sid-1', abortController, { checkIntervalMs: 1000, maxHealthFailures: 3 });
    watchdog.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(watchdog.state).toBe('running');
    watchdog.stop();
  });

  it('TC-WDOG-UNIT-009 | start() 调用——定时器启动', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    watchdog = new Watchdog(mockClient, 'sid-1', abortController, { checkIntervalMs: 1000, maxHealthFailures: 3 });
    watchdog.start();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
    watchdog.stop();
    setIntervalSpy.mockRestore();
  });

  it('TC-WDOG-UNIT-010 | stop() 调用——定时器清除', () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    watchdog = new Watchdog(mockClient, 'sid-1', abortController, { checkIntervalMs: 1000, maxHealthFailures: 3 });
    watchdog.start();
    watchdog.stop();
    expect(clearIntervalSpy).toHaveBeenCalled();
    expect((watchdog as any).timer).toBeNull();
    clearIntervalSpy.mockRestore();
  });

  it('TC-WDOG-UNIT-011 | start → stop → start——旧定时器清除，新定时器启动', () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    watchdog = new Watchdog(mockClient, 'sid-1', abortController, { checkIntervalMs: 1000, maxHealthFailures: 3 });
    watchdog.start();
    watchdog.stop();
    watchdog.start();
    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    watchdog.stop();
    clearIntervalSpy.mockRestore();
    setIntervalSpy.mockRestore();
  });

  it('TC-WDOG-UNIT-012 | 多次 stop 安全——不会 crash', () => {
    watchdog = new Watchdog(mockClient, 'sid-1', abortController, { checkIntervalMs: 1000, maxHealthFailures: 3 });
    expect(() => {
      watchdog.stop();
      watchdog.stop();
      watchdog.stop();
    }).not.toThrow();
  });

  it('TC-WDOG-UNIT-013 | 健康检查连续失败恢复——失败后恢复正常', async () => {
    mockClient.health
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    watchdog = new Watchdog(mockClient, 'sid-1', abortController, { checkIntervalMs: 1000, maxHealthFailures: 3 });
    watchdog.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect((watchdog as any).consecutiveHealthFailures).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect((watchdog as any).consecutiveHealthFailures).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect((watchdog as any).consecutiveHealthFailures).toBe(0);
    expect(watchdog.state).toBe('running');
    watchdog.stop();
  });
});
