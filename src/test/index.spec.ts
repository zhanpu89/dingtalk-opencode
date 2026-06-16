import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSendTextMessage = vi.fn().mockResolvedValue(undefined);
const mockSendMessage = vi.fn().mockResolvedValue(undefined);
const mockEnqueue = vi.fn();
const mockIsBusy = vi.fn().mockReturnValue(false);
const mockConnect = vi.fn().mockResolvedValue(undefined);
let mockDwClientInstance: any;
const mockGet = vi.fn();
const mockSet = vi.fn();
const mockCreateSession = vi.fn();
const mockSendMessageOapi = vi.fn();
const mockSessionExists = vi.fn();
const mockHealth = vi.fn();
const mockShareSession = vi.fn();
const mockExtractSummary = vi.fn();
const mockStart = vi.fn();
const mockStop = vi.fn();

vi.mock('dotenv/config');
vi.mock('dingtalk-stream', () => ({
  DWClient: vi.fn(function MockDWClient(this: any) {
    this.connected = false;
    this.registered = false;
    this.reconnecting = false;
    this.registerCallbackListener = vi.fn();
    this.on = vi.fn();
    this.connect = mockConnect;
    this.disconnect = vi.fn();
    this.socketCallBackResponse = vi.fn();
    mockDwClientInstance = this;
  }),
  TOPIC_ROBOT: 'TOPIC_ROBOT',
}));
vi.mock('../config.js', () => ({
  loadConfig: () => ({
    opencodeServerUrl: 'http://localhost:4096',
    opencodeServerPassword: '',
    dingtalkAppKey: 'test-key',
    dingtalkAppSecret: 'test-secret',
    dingtalkBotName: 'TestBot',
    requestTimeoutMs: 600_000,
    rateLimitMax: 20,
    rateLimitWindowMs: 60_000,
    logLevel: 'SILENT',
    dataDir: '/tmp/test-data',
  }),
  AppConfig: {},
}));
vi.mock('../opencode.js', () => ({
  OpenCodeClient: vi.fn(function MockOpenCodeClient(this: any) {
    this.createSession = mockCreateSession;
    this.sendMessage = mockSendMessageOapi;
    this.sessionExists = mockSessionExists;
    this.health = mockHealth;
    this.shareSession = mockShareSession;
    this.extractSummary = mockExtractSummary;
  }),
}));
vi.mock('../dingtalk.js', () => ({
  DingTalkClient: vi.fn(function MockDingTalkClient(this: any) {
    this.sendMessage = mockSendMessage;
    this.sendTextMessage = mockSendTextMessage;
  }),
}));
vi.mock('../session-store.js', () => ({
  SessionStore: vi.fn(function MockSessionStore(this: any) {
    this.get = mockGet;
    this.set = mockSet;
    this.size = vi.fn().mockReturnValue(0);
    this.flush = vi.fn();
  }),
}));
vi.mock('../message-queue.js', () => ({
  MessageQueue: vi.fn(function MockMessageQueue(this: any) {
    this.enqueue = mockEnqueue;
    this.isBusy = mockIsBusy;
    this.pendingCount = vi.fn().mockReturnValue(0);
  }),
}));
vi.mock('../watchdog.js', () => ({
  Watchdog: vi.fn(function MockWatchdog(this: any) {
    this.start = mockStart;
    this.stop = mockStop;
    this.state = 'running';
  }),
}));

const { buildReplyMessage, sendProcessingError, handleRobotMessage, getSessionKey, stripBotMention, startStreamSupervisor } = await import('../index.js');

describe('入口编排', () => {
  let capturedFn: (() => Promise<void>) | null;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBusy.mockReturnValue(false);
    capturedFn = null;
    mockEnqueue.mockImplementation((_key: string, fn: () => Promise<void>) => {
      capturedFn = fn;
      return Promise.resolve();
    });
  });

  describe('getSessionKey', () => {
    it('should compose session key from conversationId and sender id', () => {
      const msg = { conversationId: 'conv1', senderId: 'user1' } as any;
      expect(getSessionKey(msg)).toBe('default:conv1:user1');
      expect(getSessionKey(msg, 'stock')).toBe('stock:conv1:user1');
    });

    it('should prefer senderStaffId for session key', () => {
      const msg = { conversationId: 'conv1', senderId: 'user1', senderStaffId: 'staff1' } as any;
      expect(getSessionKey(msg, 'stock')).toBe('stock:conv1:staff1');
    });
  });

  describe('startStreamSupervisor', () => {
    it('should reconnect when stream remains disconnected', async () => {
      vi.useFakeTimers();
      mockDwClientInstance.connected = false;
      mockDwClientInstance.registered = false;
      mockDwClientInstance.reconnecting = false;
      const timer = startStreamSupervisor();
      await vi.advanceTimersByTimeAsync(240_000);
      expect(mockConnect).toHaveBeenCalled();
      clearInterval(timer);
      vi.useRealTimers();
    });
  });

  describe('stripBotMention', () => {
    it('should remove bot mention from text', () => {
      expect(stripBotMention('@TestBot hello')).toBe('hello');
      expect(stripBotMention('@TestBot  fix bug')).toBe('fix bug');
    });

    it('should handle text without mention', () => {
      expect(stripBotMention('hello')).toBe('hello');
    });
  });

  describe('TC-ENTRY-UNIT-001 | 正常消息处理——收到并回复', () => {
    it('should enqueue message processing', async () => {
      mockGet.mockReturnValue('existing-sid');
      mockCreateSession.mockResolvedValue({ id: 'new-sid' });
      mockSendMessageOapi.mockResolvedValue({ info: { id: 'msg1', sessionID: 'sid-1', role: 'assistant' }, parts: [{ type: 'text', text: 'ok' }] });
      mockExtractSummary.mockReturnValue({ summary: 'ok', changedFiles: [], toolNames: [], fullLength: 10 });
      mockShareSession.mockResolvedValue(null);

      const msg = JSON.stringify({
        msgtype: 'text',
        text: { content: '@TestBot 修复bug' },
        senderId: 'user1',
        senderNick: '用户1',
        conversationId: 'conv1',
        sessionWebhook: 'https://webhook',
      });
      await handleRobotMessage(msg);
      expect(mockEnqueue).toHaveBeenCalled();
      await capturedFn!();
    });
  });

  describe('TC-ENTRY-UNIT-002 | 空消息（仅 @提及）回复引导提示', () => {
    it('should reply with guide message for empty mention', async () => {
      const msg = JSON.stringify({
        msgtype: 'text',
        text: { content: '@TestBot' },
        senderId: 'user1',
        senderNick: '用户1',
        conversationId: 'conv1',
        sessionWebhook: 'https://webhook',
      });
      await handleRobotMessage(msg);
      expect(mockSendTextMessage).toHaveBeenCalledWith(
        'https://webhook',
        expect.stringContaining('你好'),
      );
      expect(capturedFn).toBeNull();
    });

    it('should reply with guide message for whitespace-only content', async () => {
      const msg = JSON.stringify({
        msgtype: 'text',
        text: { content: '@TestBot  ' },
        senderId: 'user1',
        senderNick: '用户1',
        conversationId: 'conv1',
        sessionWebhook: 'https://webhook',
      });
      await handleRobotMessage(msg);
      expect(mockSendTextMessage).toHaveBeenCalledWith(
        'https://webhook',
        expect.stringContaining('你好'),
      );
      expect(capturedFn).toBeNull();
    });
  });

  describe('TC-ENTRY-UNIT-003 | 非 text 类型消息忽略', () => {
    it('should ignore non-text message', async () => {
      const msg = JSON.stringify({
        msgtype: 'image',
        senderId: 'user1',
        conversationId: 'conv1',
      });
      await handleRobotMessage(msg);
      expect(mockSendTextMessage).not.toHaveBeenCalled();
      expect(capturedFn).toBeNull();
    });
  });

  describe('TC-ENTRY-UNIT-004 | 非法 JSON 日志警告不回复', () => {
    it('should warn on invalid JSON', async () => {
      await handleRobotMessage('not json');
      expect(mockSendTextMessage).not.toHaveBeenCalled();
      expect(capturedFn).toBeNull();
    });
  });

  describe('TC-ENTRY-UNIT-005 | session 首次创建调用 createSession', () => {
    it('should create new session when none exists', async () => {
      mockGet.mockReturnValue(undefined);
      mockCreateSession.mockResolvedValue({ id: 'new-sid' });
      mockSendMessageOapi.mockResolvedValue({ info: { id: 'msg1', sessionID: 'new-sid', role: 'assistant' }, parts: [{ type: 'text', text: 'done' }] });
      mockExtractSummary.mockReturnValue({ summary: 'done', changedFiles: [], toolNames: [], fullLength: 4 });
      mockShareSession.mockResolvedValue(null);

      const msg = JSON.stringify({
        msgtype: 'text',
        text: { content: '@TestBot hello' },
        senderId: 'user1',
        senderNick: '用户1',
        conversationId: 'conv1',
        sessionWebhook: 'https://webhook',
      });
      await handleRobotMessage(msg);
      await capturedFn!();
      expect(mockCreateSession).toHaveBeenCalledWith('钉钉-用户1');
      expect(mockSet).toHaveBeenCalled();
    });
  });

  describe('TC-ENTRY-UNIT-006 | session 已存在复用现有 sessionId', () => {
    it('should reuse existing session', async () => {
      mockGet.mockReturnValue('existing-sid');
      mockSendMessageOapi.mockResolvedValue({ info: { id: 'msg1', sessionID: 'existing-sid', role: 'assistant' }, parts: [{ type: 'text', text: 'done' }] });
      mockExtractSummary.mockReturnValue({ summary: 'done', changedFiles: [], toolNames: [], fullLength: 4 });
      mockShareSession.mockResolvedValue(null);

      const msg = JSON.stringify({
        msgtype: 'text',
        text: { content: '@TestBot hello' },
        senderId: 'user1',
        senderNick: '用户1',
        conversationId: 'conv1',
        sessionWebhook: 'https://webhook',
      });
      await handleRobotMessage(msg);
      await capturedFn!();
      expect(mockCreateSession).not.toHaveBeenCalled();
    });
  });

  describe('TC-ENTRY-UNIT-007 | DingTalk 回复失败日志记录', () => {
    it('should log error when dingtalk reply fails', async () => {
      mockGet.mockReturnValue('existing-sid');
      mockSendMessageOapi.mockResolvedValue({ info: { id: 'msg1', sessionID: 'existing-sid', role: 'assistant' }, parts: [{ type: 'text', text: 'done' }] });
      mockExtractSummary.mockReturnValue({ summary: 'done', changedFiles: [], toolNames: [], fullLength: 4 });
      mockShareSession.mockResolvedValue(null);
      mockSendMessage.mockRejectedValue(new Error('webhook expired'));

      const msg = JSON.stringify({
        msgtype: 'text',
        text: { content: '@TestBot hello' },
        senderId: 'user1',
        senderNick: '用户1',
        conversationId: 'conv1',
        sessionWebhook: 'https://webhook',
      });
      await handleRobotMessage(msg);
      await capturedFn!();
      expect(mockSendMessage).toHaveBeenCalled();
      expect(mockSendTextMessage).toHaveBeenCalled();
    });
  });

  describe('TC-ENTRY-UNIT-010 | buildReplyMessage——有摘要无文件', () => {
    it('should include summary but no file list', () => {
      const result = buildReplyMessage('摘要内容', [], [], 10, null, 'sid-1234');
      expect(result).toContain('摘要内容');
      expect(result).not.toContain('修改文件');
    });
  });

  describe('TC-ENTRY-UNIT-011 | buildReplyMessage——有文件无摘要', () => {
    it('should include file list but not default summary', () => {
      const result = buildReplyMessage('(无文本回复)', ['a.ts', 'b.ts'], [], 0, null, 'sid-1234');
      expect(result).not.toContain('处理摘要');
      expect(result).toContain('修改文件');
      expect(result).toContain('a.ts');
      expect(result).toContain('b.ts');
    });
  });

  describe('TC-ENTRY-UNIT-012 | buildReplyMessage——有 shareUrl', () => {
    it('should include share link', () => {
      const result = buildReplyMessage('summary', [], [], 10, 'https://share.url', 'sid-1234');
      expect(result).toContain('查看完整对话');
      expect(result).not.toContain('会话ID');
    });
  });

  describe('TC-ENTRY-UNIT-013 | buildReplyMessage——无 shareUrl', () => {
    it('should include session ID text', () => {
      const result = buildReplyMessage('summary', [], [], 10, null, 'sid-1234');
      expect(result).toContain('会话ID');
      expect(result).toContain('sid-1234');
    });
  });

  describe('sendProcessingError', () => {
    it('TC-ENTRY-UNIT-008 | 超时 (AbortError) 提示"任务超时"', async () => {
      await sendProcessingError('https://webhook', undefined, new Error('timeout'), 'sid-1234', true);
      expect(mockSendTextMessage).toHaveBeenCalledWith('https://webhook', expect.stringContaining('任务超时'));
    });

    it('TC-ENTRY-UNIT-009 | 其他错误提示处理失败 + 错误原因', async () => {
      await sendProcessingError('https://webhook', undefined, new Error('unknown error'), 'sid-1234', false);
      expect(mockSendTextMessage).toHaveBeenCalledWith('https://webhook', expect.stringContaining('处理失败'));
    });

    it('TC-ENTRY-UNIT-010 | fetch failed 网络错误——提示网络连接失败', async () => {
      await sendProcessingError('https://webhook', undefined, new TypeError('fetch failed'), 'sid-1234', false);
      expect(mockSendTextMessage).toHaveBeenCalledWith('https://webhook', expect.stringContaining('网络连接失败'));
    });

    it('should show server_down message when watchdog state is server_down', async () => {
      await sendProcessingError('https://webhook', 'server_down', new Error('down'), 'sid-1234', false);
      expect(mockSendTextMessage).toHaveBeenCalledWith('https://webhook', expect.stringContaining('服务不可用'));
    });
  });
});
