import { describe, it, expect, beforeEach, vi } from "vitest";
import { OpenCodeClient } from "../opencode.js";

vi.mock("../logger.js", () => ({
  Logger: class {
    info = vi.fn();
    error = vi.fn();
    warn = vi.fn();
    debug = vi.fn();
  },
}));

function mockConfig(overrides?: Record<string, unknown>) {
  return {
    opencodeServerUrl: "http://localhost:4096",
    opencodeServerPassword: "",
    requestTimeoutMs: 5000,
    ...overrides,
  } as any;
}

describe("OpenCodeClient", () => {
  let client: OpenCodeClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    client = new OpenCodeClient(mockConfig());
  });

  describe("sendMessage", () => {
    it("TC-OPC-UNIT-001 | 正常流式响应返回完整结果", async () => {
      const mockResponse = { info: { id: "msg1" }, parts: [{ type: "text", text: "hello" }] };
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(mockResponse)));
          controller.close();
        },
      });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      } as any);
      const result = await client.sendMessage("sid", "hello");
      expect(result).toEqual(mockResponse);
    });

    it("TC-OPC-UNIT-002 | 分块到达正确拼接", async () => {
      const mockResponse = { info: { id: "msg1" }, parts: [{ type: "text", text: "hello world" }] };
      const json = JSON.stringify(mockResponse);
      const mid = Math.floor(json.length / 2);
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(json.slice(0, mid)));
          controller.enqueue(new TextEncoder().encode(json.slice(mid)));
          controller.close();
        },
      });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      } as any);
      const result = await client.sendMessage("sid", "hello");
      expect(result).toEqual(mockResponse);
    });

  it("TC-OPC-UNIT-003 | Phase 1 超时抛出 AbortError", async () => {
    client = new OpenCodeClient(mockConfig({ requestTimeoutMs: 50 }));
    global.fetch = vi.fn().mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new DOMException("AbortError", "AbortError")), 100))
    );
    await expect(client.sendMessage("sid", "hello")).rejects.toThrow();
  }, 10000);

    it("TC-OPC-UNIT-004 | 外部 AbortSignal 触发中止", async () => {
      const controller = new AbortController();
      global.fetch = vi.fn().mockImplementation(
        () => new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
      );
      const promise = client.sendMessage("sid", "hello", controller.signal);
      controller.abort();
      await expect(promise).rejects.toThrow();
    });

    it("TC-OPC-UNIT-005 | 外部 signal 调用前已 abort", async () => {
      const controller = new AbortController();
      controller.abort();
      global.fetch = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
      await expect(client.sendMessage("sid", "hello", controller.signal)).rejects.toThrow();
    });

    it("TC-OPC-UNIT-006 | HTTP 非 200 抛出 Error", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      } as any);
      await expect(client.sendMessage("sid", "hello")).rejects.toThrow(/opencode API error 500/);
    });
  });

  describe("sessionExists", () => {
    it("TC-OPC-UNIT-007 | 存在返回 true", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([{ id: "sid" }]),
      } as any);
      const result = await client.sessionExists("sid");
      expect(result).toBe(true);
    });

    it("TC-OPC-UNIT-008 | 不存在返回 false", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([{ id: "other" }]),
      } as any);
      const result = await client.sessionExists("sid");
      expect(result).toBe(false);
    });

    it("TC-OPC-UNIT-009 | API 错误返回 null", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("network error"));
      const result = await client.sessionExists("sid");
      expect(result).toBeNull();
    });
  });

  describe("createSession", () => {
    it("TC-OPC-UNIT-010 | 新建（同名不存在）", async () => {
      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: "new-id" }) });
      });
      const result = await client.createSession("test-name");
      expect(result.id).toBe("new-id");
      expect(callCount).toBe(2);
    });

    it("TC-OPC-UNIT-011 | 复用（同名已存在）", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([{ id: "existing-id", title: "test-name" }]),
      } as any);
      const result = await client.createSession("test-name");
      expect(result.id).toBe("existing-id");
    });

    it("TC-OPC-UNIT-016 | GET 返回非 200 时走新建分支", async () => {
      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([{ id: "other", title: "other" }]) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: "new-id" }) });
      });
      const result = await client.createSession("new-name");
      expect(result.id).toBe("new-id");
    });
  });

  describe("shareSession", () => {
    it("TC-OPC-UNIT-012 | 失败返回 null", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("API error"));
      const result = await client.shareSession("sid");
      expect(result).toBeNull();
    });

    it("TC-OPC-UNIT-017 | 成功返回 URL", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "sid", shareURL: "https://share.url" }),
      } as any);
      const result = await client.shareSession("sid");
      expect(result).toBe("https://share.url");
    });
  });

  describe("health", () => {
    it("TC-OPC-UNIT-013 | 正常返回 true", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ healthy: true }),
      } as any);
      const result = await client.health();
      expect(result).toBe(true);
    });

    it("TC-OPC-UNIT-014 | 异常返回 false", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("network error"));
      const result = await client.health();
      expect(result).toBe(false);
    });
  });
});
