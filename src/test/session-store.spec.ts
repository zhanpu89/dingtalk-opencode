import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('node:fs');

import { SessionStore } from '../session-store.js';

describe('SessionStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('{}');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('TC-SESS-UNIT-001 | 首次启动文件不存在——创建空文件', () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (fs.mkdirSync as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const store = new SessionStore('/tmp/test-store.json');
    expect(fs.mkdirSync).toHaveBeenCalled();
    expect(store.size()).toBe(0);
  });

  it('TC-SESS-UNIT-002 | set + flush——JSON 文件正确写入', () => {
    (fs.writeFileSync as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const store = new SessionStore('/tmp/test-store.json');
    store.set('key1', 'sid1');
    store.flush();
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/tmp/test-store.json',
      expect.stringContaining('"key1": "sid1"'),
      'utf-8',
    );
  });

  it('TC-SESS-UNIT-003 | 程序启动加载——文件内容正确恢复为 Map', () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('{"k1":"v1","k2":"v2"}');
    const store = new SessionStore('/tmp/test-store.json');
    expect(store.get('k1')).toBe('v1');
    expect(store.get('k2')).toBe('v2');
    expect(store.size()).toBe(2);
  });

  it('TC-SESS-UNIT-004 | 多次 set 不频繁写盘——2s 内仅 flush 一次', () => {
    (fs.writeFileSync as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const store = new SessionStore('/tmp/test-store.json');
    store.set('k1', 'v1');
    store.set('k2', 'v2');
    store.set('k3', 'v3');
    vi.advanceTimersByTime(2000);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('TC-SESS-UNIT-005 | 文件损坏——日志错误，空 Map 启动', () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('invalid json{{{');
    const store = new SessionStore('/tmp/test-store.json');
    expect(store.size()).toBe(0);
  });

  it('TC-SESS-UNIT-006 | get 不存在 key——返回 undefined', () => {
    const store = new SessionStore('/tmp/test-store.json');
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('TC-SESS-UNIT-007 | size——返回正确条目数', () => {
    const store = new SessionStore('/tmp/test-store.json');
    store.set('k1', 'v1');
    store.set('k2', 'v2');
    expect(store.size()).toBe(2);
  });

  it('TC-SESS-UNIT-008 | flush——dirty=false 时直接返回', () => {
    (fs.writeFileSync as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const store = new SessionStore('/tmp/test-store.json');
    store.flush();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('TC-SESS-UNIT-009 | flush——writeFileSync 异常被 catch', () => {
    (fs.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('disk full');
    });
    const store = new SessionStore('/tmp/test-store.json');
    store.set('k1', 'v1');
    expect(() => store.flush()).not.toThrow();
  });
});
