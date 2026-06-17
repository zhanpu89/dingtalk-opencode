import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildReplyMessage, sendProcessingError, processAIMessage } from "../ai-handler.js";
import { Watchdog } from "../watchdog.js";
import { MessageQueue } from "../message-queue.js";

vi.mock("../logger.js", () => ({
  Logger: class {
    info = vi.fn();
    error = vi.fn();
    warn = vi.fn();
    debug = vi.fn();
  },
}));

describe("buildReplyMessage", () => {
  it("TC-MSG-UNIT-020 | 处理成功时返回完整回复", () => {
    const result = buildReplyMessage("处理完成", ["file1.ts"], ["edit"], 100, null, "session123");
    expect(result.title).toBe("OpenCode 任务完成");
    expect(result.text).toContain("处理完成");
    expect(result.text).toContain("file1.ts");
    expect(result.text).toContain("edit");
  });

  it("无文件无工具时仍然返回", () => {
    const result = buildReplyMessage("(无文本回复)", [], [], 0, null, "sid");
    expect(result.text).not.toContain("修改文件");
  });

  it("有 shareUrl 时包含链接", () => {
    const result = buildReplyMessage("done", [], [], 0, "https://share.url", "sid");
    expect(result.text).toContain("查看完整对话");
  });
});

describe("sendProcessingError", () => {
  const mockDingtalk = { sendTextMessage: vi.fn().mockResolvedValue(undefined) } as any;
  const mockConfig = { opencodeServerUrl: "http://localhost:4096", requestTimeoutMs: 600000 } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("TC-MSG-UNIT-014 | 看门狗 server_down 发送服务不可用提示", async () => {
    await sendProcessingError(mockDingtalk, mockConfig, "webhook", "server_down", new Error("fail"), "sid", false);
    expect(mockDingtalk.sendTextMessage).toHaveBeenCalledWith("webhook", expect.stringContaining("服务不可用"));
  });

  it("超时发送任务超时提示", async () => {
    const err = new Error("AbortError");
    err.name = "AbortError";
    await sendProcessingError(mockDingtalk, mockConfig, "webhook", undefined, err, "sid", true);
    expect(mockDingtalk.sendTextMessage).toHaveBeenCalledWith("webhook", expect.stringContaining("任务超时"));
  });

  it("TypeError fetch failed 发送网络错误提示", async () => {
    await sendProcessingError(mockDingtalk, mockConfig, "webhook", undefined, new TypeError("fetch failed"), "sid", false);
    expect(mockDingtalk.sendTextMessage).toHaveBeenCalledWith("webhook", expect.stringContaining("网络连接失败"));
  });

  it("其他错误发送通用失败提示", async () => {
    await sendProcessingError(mockDingtalk, mockConfig, "webhook", undefined, new Error("unknown"), "sid", false);
    expect(mockDingtalk.sendTextMessage).toHaveBeenCalledWith("webhook", expect.stringContaining("处理失败"));
  });

  it("TC-MSG-UNIT-016 | 钉钉消息发送异常内部 catch", async () => {
    const failingDingtalk = { sendTextMessage: vi.fn().mockRejectedValue(new Error("network")) } as any;
    await expect(sendProcessingError(failingDingtalk, mockConfig, "webhook", undefined, new Error("err"), "sid", false)).resolves.toBeUndefined();
  });
});

describe("processAIMessage", () => {
  const mockOpencode = {
    sessionExists: vi.fn(),
    createSession: vi.fn(),
    sendMessage: vi.fn(),
    extractSummary: vi.fn(),
    shareSession: vi.fn(),
  };
  const mockDingtalk = {
    sendTextMessage: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
  const mockSessions = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  };
  const mockConfig = {
    opencodeServerUrl: "http://localhost:4096",
    requestTimeoutMs: 600000,
    dingtalkBotName: "OpenCode",
  } as any;
  const mockMsg = {
    sessionWebhook: "webhook",
    senderNick: "TestUser",
    senderStaffId: "staff1",
    conversationId: "conv1",
    senderId: "sender1",
  } as any;

  const ctx = {
    opencode: mockOpencode as any,
    dingtalk: mockDingtalk as any,
    config: mockConfig,
    sessions: mockSessions as any,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSessions.get.mockReturnValue(undefined);
    mockOpencode.createSession.mockResolvedValue({ id: "session-new" });
    mockOpencode.sessionExists.mockResolvedValue(true);
    mockOpencode.sendMessage.mockResolvedValue({
      info: { id: "msg1" },
      parts: [{ type: "text", text: "ok" }],
    });
    mockOpencode.extractSummary.mockReturnValue({
      summary: "done",
      changedFiles: [],
      toolNames: [],
      fullLength: 10,
    });
    mockOpencode.shareSession.mockResolvedValue(null);
  });



  it("TC-MSG-UNIT-020 | 正常处理成功", async () => {
    await processAIMessage(ctx, "key", "hello", mockMsg);
    expect(mockOpencode.createSession).toHaveBeenCalled();
    expect(mockOpencode.sendMessage).toHaveBeenCalled();
    expect(mockDingtalk.sendMessage).toHaveBeenCalled();
  });

  it("TC-MSG-UNIT-005 | 同 sessionKey 消息串行处理", async () => {
    const queue = new MessageQueue();
    const order: number[] = [];
    const p1 = queue.enqueue("key", async () => { order.push(1); });
    const p2 = queue.enqueue("key", async () => { order.push(2); });
    await p2;
    expect(order).toEqual([1, 2]);
  });

  it("TC-MSG-UNIT-006 | 不同 sessionKey 消息并行处理", async () => {
    const queue = new MessageQueue();
    let done1 = false;
    let done2 = false;
    const p1 = queue.enqueue("key1", async () => { await new Promise(r => setTimeout(r, 10)); done1 = true; });
    const p2 = queue.enqueue("key2", async () => { done2 = true; });
    await p1;
    expect(done2).toBe(true);
  });

  it("TC-MSG-UNIT-007 | 前序任务失败不影响后续任务", async () => {
    const queue = new MessageQueue();
    const order: number[] = [];
    const p1 = queue.enqueue("key", async () => { order.push(1); throw new Error("fail"); });
    const p2 = queue.enqueue("key", async () => { order.push(2); });
    await p1.catch(() => {});
    await p2;
    expect(order).toEqual([1, 2]);
  });

  it("TC-MSG-UNIT-012 | 最大重试 3 次", async () => {
    mockOpencode.sendMessage.mockRejectedValue(new TypeError("fetch failed"));
    await processAIMessage(ctx, "key", "hello", mockMsg);
    expect(mockOpencode.sendMessage).toHaveBeenCalledTimes(4);
  }, 15000);

  it("TC-MSG-UNIT-009 | 重试条件：TypeError fetch failed", async () => {
    mockOpencode.sendMessage.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce({
      info: { id: "msg2" },
      parts: [{ type: "text", text: "ok" }],
    });
    mockOpencode.extractSummary.mockReturnValue({ summary: "done", changedFiles: [], toolNames: [], fullLength: 10 });
    await processAIMessage(ctx, "key", "hello", mockMsg);
    expect(mockOpencode.sendMessage).toHaveBeenCalledTimes(2);
  }, 15000);

  it("TC-MSG-UNIT-022 | MessageQueue 链完成后延迟 1s 清理", async () => {
    const queue = new MessageQueue();
    await queue.enqueue("key", async () => {});
    expect(queue.isBusy("key")).toBe(true);
    await new Promise(r => setTimeout(r, 1100));
    expect(queue.isBusy("key")).toBe(false);
  }, 5000);
});
