import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DingTalkClient } from '../dingtalk.js';

describe('DingTalkClient', () => {
  let client: DingTalkClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    client = new DingTalkClient('TestBot');
  });

  it('TC-DING-UNIT-001 | sendMessage 正常——fetch POST 调用，msgtype=markdown', async () => {
    mockFetch.mockResolvedValue({ ok: true } as Response);
    const result = await client.sendMessage('https://webhook', 'content');
    expect(result).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('https://webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.stringContaining('"msgtype":"markdown"'),
    });
  });

  it('TC-DING-UNIT-002 | sendTextMessage 正常——fetch POST 调用，msgtype=text', async () => {
    mockFetch.mockResolvedValue({ ok: true } as Response);
    const result = await client.sendTextMessage('https://webhook', 'content');
    expect(result).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('https://webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.stringContaining('"msgtype":"text"'),
    });
  });

  it('TC-DING-UNIT-003 | 网络异常 (fetch throw)——catch 日志 warn，不抛异常', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    await expect(client.sendMessage('https://webhook', 'content')).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('TC-DING-UNIT-004 | HTTP 非 200——不抛异常', async () => {
    const textFn = vi.fn().mockResolvedValue('error body');
    mockFetch.mockResolvedValue({ ok: false, status: 400, text: textFn } as unknown as Response);
    await expect(client.sendMessage('https://webhook', 'content')).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(textFn).toHaveBeenCalled();
  });

  it('TC-DING-UNIT-005 | sendTextMessage 网络异常', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    await expect(client.sendTextMessage('https://webhook', 'content')).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('TC-DING-UNIT-006 | sendMessage——超长文本发送', async () => {
    const longContent = 'A'.repeat(10000);
    mockFetch.mockResolvedValue({ ok: true } as Response);
    await client.sendMessage('https://webhook', longContent);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.markdown.text).toBe(longContent);
  });

  it('TC-DING-UNIT-007 | sendTextMessage——空内容发送', async () => {
    mockFetch.mockResolvedValue({ ok: true } as Response);
    await client.sendTextMessage('https://webhook', '');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.text.content).toBe('');
  });
});
