import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenCodeClient } from '../opencode.js';
import type { AppConfig } from '../config.js';

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
    logLevel: 'INFO',
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

function createMockStream(chunks: string[]): ReadableStream<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function makeMockResponse(overrides: Partial<Response> = {}): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn(),
    text: vi.fn(),
    body: null,
    headers: new Headers(),
    ...overrides,
  } as unknown as Response;
}

describe('OpenCodeClient', () => {
  let client: OpenCodeClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  describe('sendMessage', () => {
    it('TC-OAPI-UNIT-001 | 正常流式响应——拼接所有 chunk', async () => {
      const stream = createMockStream([
        '{"parts":[{"type":"text","text":"hello"}]}',
      ]);
      mockFetch.mockResolvedValue(makeMockResponse({ body: stream }));
      client = new OpenCodeClient(makeConfig());
      const result = await client.sendMessage('sid-123', 'hi');
      expect(result).toEqual({ parts: [{ type: 'text', text: 'hello' }] });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('TC-OAPI-UNIT-002 | Phase 1 超时——AbortError 传播', async () => {
      client = new OpenCodeClient(makeConfig({ requestTimeoutMs: 1 }));
      mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.signal?.aborted) {
          throw new DOMException('The operation was aborted', 'AbortError');
        }
        await new Promise((_, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted', 'AbortError'));
            });
          }
        });
      });
      await expect(client.sendMessage('sid-123', 'hi')).rejects.toMatchObject({
        name: 'AbortError',
      });
    });

    it('TC-OAPI-UNIT-003 | 外部 AbortSignal 触发流中断', async () => {
      const externalController = new AbortController();
      mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted', 'AbortError'));
            });
          }
        });
      });
      client = new OpenCodeClient(makeConfig({ requestTimeoutMs: 60000 }));
      const promise = client.sendMessage('sid-123', 'hi', externalController.signal);
      externalController.abort();
      await expect(promise).rejects.toThrow();
    });

    it('TC-OAPI-UNIT-004 | 外部 signal 在调用前已 abort', async () => {
      const externalController = new AbortController();
      externalController.abort();
      mockFetch.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));
      client = new OpenCodeClient(makeConfig());
      await expect(client.sendMessage('sid-123', 'hi', externalController.signal)).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('TC-OAPI-UNIT-005 | HTTP 非 200 响应', async () => {
      const textFn = vi.fn().mockResolvedValue('server error');
      mockFetch.mockResolvedValue(makeMockResponse({ ok: false, status: 500, text: textFn }));
      client = new OpenCodeClient(makeConfig());
      await expect(client.sendMessage('sid-123', 'hi')).rejects.toThrow('opencode API error 500');
    });

    it('TC-OAPI-UNIT-006 | HTTP 非 200（Phase 2 后）——流读取正常', async () => {
      const stream = createMockStream(['{"parts":[]}']);
      mockFetch.mockResolvedValue(makeMockResponse({ ok: true, status: 200, body: stream }));
      client = new OpenCodeClient(makeConfig());
      const result = await client.sendMessage('sid-123', 'hi');
      expect(result).toEqual({ parts: [] });
    });
  });

  describe('sessionExists', () => {
    it('TC-OAPI-UNIT-007 | session 存在返回 true', async () => {
      mockFetch.mockResolvedValue(makeMockResponse({
        json: vi.fn().mockResolvedValue([{ id: 'sid-1' }, { id: 'sid-2' }]),
      }));
      client = new OpenCodeClient(makeConfig());
      const result = await client.sessionExists('sid-1');
      expect(result).toBe(true);
    });

    it('TC-OAPI-UNIT-008 | session 不存在返回 false', async () => {
      mockFetch.mockResolvedValue(makeMockResponse({
        json: vi.fn().mockResolvedValue([{ id: 'sid-2' }]),
      }));
      client = new OpenCodeClient(makeConfig());
      const result = await client.sessionExists('sid-1');
      expect(result).toBe(false);
    });

    it('TC-OAPI-UNIT-009 | API 错误返回 null', async () => {
      mockFetch.mockRejectedValue(new Error('network error'));
      client = new OpenCodeClient(makeConfig());
      const result = await client.sessionExists('sid-1');
      expect(result).toBeNull();
    });
  });

  describe('createSession', () => {
    it('TC-OAPI-UNIT-010 | 新 session 调用 POST /session', async () => {
      mockFetch
        .mockResolvedValueOnce(makeMockResponse({
          json: vi.fn().mockResolvedValue([]),
        }))
        .mockResolvedValueOnce(makeMockResponse({
          json: vi.fn().mockResolvedValue({ id: 'new-sid', title: '标题' }),
        }));
      client = new OpenCodeClient(makeConfig());
      const result = await client.createSession('标题');
      expect(result.id).toBe('new-sid');
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const secondCall = mockFetch.mock.calls[1];
      expect(secondCall[0]).toBe('http://localhost:4096/session');
      expect(secondCall[1].method).toBe('POST');
    });

    it('TC-OAPI-UNIT-011 | 已有同名复用', async () => {
      mockFetch.mockResolvedValueOnce(makeMockResponse({
        json: vi.fn().mockResolvedValue([{ id: 'existing', title: '标题' }]),
      }));
      client = new OpenCodeClient(makeConfig());
      const result = await client.createSession('标题');
      expect(result.id).toBe('existing');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('shareSession', () => {
    it('TC-OAPI-UNIT-012 | 成功返回 shareURL', async () => {
      mockFetch.mockResolvedValue(makeMockResponse({
        json: vi.fn().mockResolvedValue({ id: 'sid', shareURL: 'https://share.url' }),
      }));
      client = new OpenCodeClient(makeConfig());
      const result = await client.shareSession('sid');
      expect(result).toBe('https://share.url');
    });

    it('TC-OAPI-UNIT-013 | 失败返回 null', async () => {
      mockFetch.mockRejectedValue(new Error('fail'));
      client = new OpenCodeClient(makeConfig());
      const result = await client.shareSession('sid');
      expect(result).toBeNull();
    });
  });

  describe('health', () => {
    it('TC-OAPI-UNIT-014 | 服务正常返回 true', async () => {
      mockFetch.mockResolvedValue(makeMockResponse({
        json: vi.fn().mockResolvedValue({ healthy: true }),
      }));
      client = new OpenCodeClient(makeConfig());
      const result = await client.health();
      expect(result).toBe(true);
    });

    it('TC-OAPI-UNIT-015 | 服务异常返回 false', async () => {
      mockFetch.mockRejectedValue(new Error('fail'));
      client = new OpenCodeClient(makeConfig());
      const result = await client.health();
      expect(result).toBe(false);
    });
  });

  describe('extractSummary', () => {
    it('TC-OAPI-UNIT-016 | 空 parts', () => {
      client = new OpenCodeClient(makeConfig());
      const result = client.extractSummary({ parts: [], info: { id: '', sessionID: '', role: '' } });
      expect(result.summary).toBe('(无文本回复)');
      expect(result.changedFiles).toEqual([]);
      expect(result.toolNames).toEqual([]);
      expect(result.fullLength).toBe(0);
    });
  });

  describe('request (auth)', () => {
    it('TC-OAPI-UNIT-017 | 已配置 auth 时携带 Authorization 头', async () => {
      mockFetch.mockResolvedValue(makeMockResponse({
        json: vi.fn().mockResolvedValue([]),
      }));
      const encoded = Buffer.from('opencode:secret').toString('base64');
      client = new OpenCodeClient(makeConfig({ opencodeServerPassword: 'secret' }));
      await client.sessionExists('sid-1');
      expect(mockFetch.mock.calls[0][1].headers['Authorization']).toBe(`Basic ${encoded}`);
    });

    it('TC-OAPI-UNIT-018 | 未配置 auth 时不携带 Authorization 头', async () => {
      mockFetch.mockResolvedValue(makeMockResponse({
        json: vi.fn().mockResolvedValue([]),
      }));
      client = new OpenCodeClient(makeConfig({ opencodeServerPassword: '' }));
      await client.sessionExists('sid-1');
      expect(mockFetch.mock.calls[0][1].headers['Authorization']).toBeUndefined();
    });
  });

  describe('integration', () => {
    it('TC-OAPI-INTG-001 | sendMessage 完整流式流程——Phase 1 + Phase 2', async () => {
      const stream = createMockStream(['{"parts":[{"type":"text","text":"done"}]}']);
      mockFetch.mockResolvedValue(makeMockResponse({
        ok: true,
        status: 200,
        body: stream,
      }));
      client = new OpenCodeClient(makeConfig({
        opencodeServerUrl: 'http://localhost:4096',
        opencodeServerPassword: '',
      }));
      const result = await client.sendMessage('sid-123', 'hi');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toBe('http://localhost:4096/session/sid-123/message');
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.parts[0].text).toBe('hi');
      expect(result).toEqual({ parts: [{ type: 'text', text: 'done' }] });
    });
  });
});
