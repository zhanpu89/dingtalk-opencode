import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OpenCodeClient } from '../opencode.js';
import type { DingTalkClient } from '../dingtalk.js';
import type { SessionStore } from '../session-store.js';
import type { AppConfig } from '../config.js';
import type { AIMessageContext } from '../ai-handler.js';

const mockWatchdogStart = vi.fn();
const mockWatchdogStop = vi.fn();

vi.mock('../watchdog.js', () => ({
  Watchdog: vi.fn(function MockWatchdog(this: any) {
    this.start = mockWatchdogStart;
    this.stop = mockWatchdogStop;
    this.state = 'running';
  }),
}));

const { buildReplyMessage, sendProcessingError, processAIMessage } = await import('../ai-handler.js');

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    opencodeServerUrl: 'http://localhost:4096',
    opencodeServerPassword: '',
    dingtalkAppKey: 'key',
    dingtalkAppSecret: 'secret',
    dingtalkBotName: 'Bot',
    requestTimeoutMs: 600_000,
    rateLimitMax: 20,
    rateLimitWindowMs: 60_000,
    logLevel: 'SILENT',
    dataDir: 'data',
    projectsConfigPath: 'projects.json',
    allowedProjectRoots: [],
    projectServerPortStart: 4100,
    projectServerHostname: '127.0.0.1',
    projectServerIdleMs: 7_200_000,
    projectSwitchRequired: false,
    maxMessagesPerSession: 0,
    ...overrides,
  };
}

function makeMsg(): any {
  return {
    msgtype: 'text',
    text: { content: '@Bot hi' },
    senderId: 'user1',
    senderStaffId: 'staff1',
    senderNick: '用户1',
    conversationId: 'conv1',
    sessionWebhook: 'https://webhook',
  };
}

function makeContext(overrides: Partial<AIMessageContext> = {}): AIMessageContext {
  return {
    opencode: {
      sendMessage: vi.fn(),
      createSession: vi.fn(),
      shareSession: vi.fn(),
      extractSummary: vi.fn(),
    } as unknown as OpenCodeClient,
    dingtalk: {
      sendMessage: vi.fn(),
      sendTextMessage: vi.fn().mockResolvedValue(undefined),
    } as unknown as DingTalkClient,
    config: makeConfig(),
    sessions: {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as SessionStore,
    messagesPerSession: new Map(),
    timeoutsPerSession: new Map(),
    ...overrides,
  };
}

// ── buildReplyMessage ──

describe('buildReplyMessage', () => {
  it('TC-AIH-UNIT-016 | 有摘要无文件', () => {
    const r = buildReplyMessage('摘要内容', [], [], 0, null, 'sid-123');
    expect(r).toContain('处理摘要');
    expect(r).toContain('摘要内容');
    expect(r).not.toContain('修改文件');
    expect(r).toContain('会话ID');
  });

  it('TC-AIH-UNIT-017 | summary="(无文本回复)" 不含摘要', () => {
    const r = buildReplyMessage('(无文本回复)', ['a.ts', 'b.ts'], [], 0, null, 'sid');
    expect(r).not.toContain('处理摘要');
    expect(r).toContain('a.ts');
    expect(r).toContain('b.ts');
  });

  it('TC-AIH-UNIT-018 | 有工具名', () => {
    const r = buildReplyMessage('摘要', [], ['read', 'edit'], 0, null, 's');
    expect(r).toContain('read');
    expect(r).toContain('edit');
  });

  it('TC-AIH-UNIT-019 | fullLength > 0', () => {
    const r = buildReplyMessage('摘要', [], [], 1234, null, 's');
    expect(r).toContain('1234');
  });

  it('TC-AIH-UNIT-020 | 有 shareUrl', () => {
    const r = buildReplyMessage('摘要', [], [], 0, 'https://u', 's');
    expect(r).toContain('查看完整对话');
    expect(r).not.toContain('会话ID');
  });

  it('TC-AIH-UNIT-021 | 无 shareUrl', () => {
    const r = buildReplyMessage('摘要', [], [], 0, null, 'sid-1234');
    expect(r).toContain('会话ID');
    expect(r).toContain('sid-1234');
  });

  it('TC-AIH-UNIT-022 | 综合', () => {
    const r = buildReplyMessage('sum', ['f.ts'], ['t1'], 100, 'https://u', 's');
    expect(r).toContain('处理摘要');
    expect(r).toContain('修改文件');
    expect(r).toContain('使用操作');
    expect(r).toContain('100');
    expect(r).toContain('查看完整对话');
  });
});

// ── sendProcessingError ──

describe('sendProcessingError', () => {
  const config = makeConfig();
  const webhook = 'https://webhook';

  it('TC-AIH-UNIT-023 | server_down', async () => {
    const stm = vi.fn().mockResolvedValue(undefined);
    await sendProcessingError({ sendTextMessage: stm } as unknown as DingTalkClient, config, webhook, 'server_down', new Error('x'), 's', false);
    expect(stm).toHaveBeenCalledWith(webhook, expect.stringContaining('服务不可用'));
  });

  it('TC-AIH-UNIT-024 | isTimeout', async () => {
    const stm = vi.fn().mockResolvedValue(undefined);
    await sendProcessingError({ sendTextMessage: stm } as unknown as DingTalkClient, config, webhook, undefined, new Error('t'), 's', true);
    expect(stm).toHaveBeenCalledWith(webhook, expect.stringContaining('任务超时'));
  });

  it('TC-AIH-UNIT-025 | fetch failed', async () => {
    const stm = vi.fn().mockResolvedValue(undefined);
    await sendProcessingError({ sendTextMessage: stm } as unknown as DingTalkClient, config, webhook, undefined, new TypeError('fetch failed'), 's', false);
    expect(stm).toHaveBeenCalledWith(webhook, expect.stringContaining('网络连接失败'));
  });

  it('TC-AIH-UNIT-026 | 普通错误', async () => {
    const stm = vi.fn().mockResolvedValue(undefined);
    await sendProcessingError({ sendTextMessage: stm } as unknown as DingTalkClient, config, webhook, undefined, new Error('unknown'), 's', false);
    expect(stm).toHaveBeenCalledWith(webhook, expect.stringContaining('处理失败'));
  });

  it('TC-AIH-UNIT-027 | sendTextMessage 自身失败不抛异常', async () => {
    const stm = vi.fn().mockRejectedValue(new Error('fail'));
    await expect(sendProcessingError({ sendTextMessage: stm } as unknown as DingTalkClient, config, webhook, undefined, new Error('x'), 's', false)).resolves.toBeUndefined();
  });
});

// ── processAIMessage ──

describe('processAIMessage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockWatchdogStart.mockClear();
    mockWatchdogStop.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('TC-AIH-UNIT-001 | session 已存在，复用', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ info: { id: 'm', sessionID: 's', role: 'assistant' }, parts: [{ type: 'text', text: 'ok' }] });
    const createSession = vi.fn();
    const ctx = makeContext({
      opencode: { sendMessage, createSession, shareSession: vi.fn().mockResolvedValue(null), extractSummary: vi.fn().mockReturnValue({ summary: 'ok', changedFiles: [], toolNames: [], fullLength: 0 }) } as unknown as OpenCodeClient,
      sessions: { get: vi.fn().mockReturnValue('existing-sid'), set: vi.fn(), delete: vi.fn() } as unknown as SessionStore,
    });

    const p = processAIMessage(ctx, 'k', 'hi', makeMsg());
    await vi.advanceTimersByTimeAsync(1000);
    await p;

    expect(createSession).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('existing-sid', 'hi', expect.any(AbortSignal));
  });

  it('TC-AIH-UNIT-002 | session 不存在，创建', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ info: { id: 'm', sessionID: 's', role: 'assistant' }, parts: [{ type: 'text', text: 'ok' }] });
    const createSession = vi.fn().mockResolvedValue({ id: 'new-sid' });
    const sessions = { get: vi.fn().mockReturnValue(undefined), set: vi.fn(), delete: vi.fn() } as unknown as SessionStore;
    const ctx = makeContext({
      opencode: { sendMessage, createSession, shareSession: vi.fn().mockResolvedValue(null), extractSummary: vi.fn().mockReturnValue({ summary: 'ok', changedFiles: [], toolNames: [], fullLength: 0 }) } as unknown as OpenCodeClient,
      sessions,
    });

    const p = processAIMessage(ctx, 'k', 'hi', makeMsg());
    await vi.advanceTimersByTimeAsync(1000);
    await p;

    expect(createSession).toHaveBeenCalledWith('钉钉-用户1');
    expect(sessions.set).toHaveBeenCalledWith('k', 'new-sid');
  });

  it('TC-AIH-UNIT-005 | 成功后发送摘要回复', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ info: { id: 'm', sessionID: 's', role: 'assistant' }, parts: [{ type: 'text', text: 'ok' }] });
    const dingtalk = { sendMessage: vi.fn().mockResolvedValue(undefined), sendTextMessage: vi.fn().mockResolvedValue(undefined) } as unknown as DingTalkClient;
    const ctx = makeContext({
      opencode: { sendMessage, createSession: vi.fn(), shareSession: vi.fn().mockResolvedValue(null), extractSummary: vi.fn().mockReturnValue({ summary: 'done', changedFiles: ['a.ts'], toolNames: ['edit'], fullLength: 50 }) } as unknown as OpenCodeClient,
      dingtalk,
      sessions: { get: vi.fn().mockReturnValue('s'), set: vi.fn(), delete: vi.fn() } as unknown as SessionStore,
    });

    const p = processAIMessage(ctx, 'k', 'hi', makeMsg());
    await vi.advanceTimersByTimeAsync(1000);
    await p;

    expect(dingtalk.sendMessage).toHaveBeenCalledTimes(1);
    const reply = (dingtalk.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(reply).toContain('done');
    expect(reply).toContain('a.ts');
  });

  it('TC-AIH-UNIT-006 | DingTalk 回复失败，发送通知', async () => {
    const dingtalk = {
      sendMessage: vi.fn().mockRejectedValue(new Error('webhook expired')),
      sendTextMessage: vi.fn().mockResolvedValue(undefined),
    } as unknown as DingTalkClient;
    const ctx = makeContext({
      opencode: { sendMessage: vi.fn().mockResolvedValue({ info: { id: 'm', sessionID: 's', role: 'assistant' }, parts: [{ type: 'text', text: 'ok' }] }), createSession: vi.fn(), shareSession: vi.fn().mockResolvedValue(null), extractSummary: vi.fn().mockReturnValue({ summary: 'done', changedFiles: [], toolNames: [], fullLength: 0 }) } as unknown as OpenCodeClient,
      dingtalk,
      sessions: { get: vi.fn().mockReturnValue('s'), set: vi.fn(), delete: vi.fn() } as unknown as SessionStore,
    });

    const p = processAIMessage(ctx, 'k', 'hi', makeMsg());
    await vi.advanceTimersByTimeAsync(1000);
    await p;

    expect(dingtalk.sendTextMessage).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('任务已完成，但结果发送失败'));
  });

  it('TC-AIH-UNIT-007 | 网络错误重试成功', async () => {
    const sessions = { get: vi.fn().mockReturnValue('s'), set: vi.fn(), delete: vi.fn() } as unknown as SessionStore;
    const createSession = vi.fn().mockResolvedValue({ id: 'retry-sid' });
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ info: { id: 'm', sessionID: 'rs', role: 'assistant' }, parts: [{ type: 'text', text: 'ok' }] });
    const dingtalk = { sendMessage: vi.fn().mockResolvedValue(undefined), sendTextMessage: vi.fn().mockResolvedValue(undefined) } as unknown as DingTalkClient;
    const ctx = makeContext({
      opencode: { sendMessage, createSession, shareSession: vi.fn().mockResolvedValue(null), extractSummary: vi.fn().mockReturnValue({ summary: 'ok', changedFiles: [], toolNames: [], fullLength: 0 }) } as unknown as OpenCodeClient,
      dingtalk,
      sessions,
    });

    const p = processAIMessage(ctx, 'k', 'hi', makeMsg());
    await vi.advanceTimersByTimeAsync(10000);
    await p;

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('TC-AIH-UNIT-008 | 网络错误重试耗尽', async () => {
    const sessions = { get: vi.fn().mockReturnValue('s'), set: vi.fn(), delete: vi.fn() } as unknown as SessionStore;
    const dingtalk = { sendMessage: vi.fn(), sendTextMessage: vi.fn().mockResolvedValue(undefined) } as unknown as DingTalkClient;
    const ctx = makeContext({
      opencode: { sendMessage: vi.fn().mockRejectedValue(new TypeError('fetch failed')), createSession: vi.fn().mockResolvedValue({ id: 'r' }), shareSession: vi.fn(), extractSummary: vi.fn() } as unknown as OpenCodeClient,
      dingtalk,
      sessions,
    });

    const p = processAIMessage(ctx, 'k', 'hi', makeMsg());
    await vi.advanceTimersByTimeAsync(30000);
    await p;

    expect(dingtalk.sendTextMessage).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('网络连接失败'));
  });

  it('TC-AIH-UNIT-015 | 普通 Error——不重试', async () => {
    const dingtalk = { sendMessage: vi.fn(), sendTextMessage: vi.fn().mockResolvedValue(undefined) } as unknown as DingTalkClient;
    const ctx = makeContext({
      opencode: { sendMessage: vi.fn().mockRejectedValue(new Error('unknown')), createSession: vi.fn(), shareSession: vi.fn(), extractSummary: vi.fn() } as unknown as OpenCodeClient,
      dingtalk,
      sessions: { get: vi.fn().mockReturnValue('s'), set: vi.fn(), delete: vi.fn() } as unknown as SessionStore,
    });

    const p = processAIMessage(ctx, 'k', 'hi', makeMsg());
    await vi.advanceTimersByTimeAsync(1000);
    await p;

    expect(dingtalk.sendTextMessage).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('处理失败'));
  });
});
