import { describe, it, expect, vi } from "vitest";
import { DingTalkClient } from "../dingtalk.js";

vi.mock("../logger.js", () => ({
  Logger: class {
    info = vi.fn();
    error = vi.fn();
    warn = vi.fn();
    debug = vi.fn();
  },
}));

describe("DingTalkClient", () => {
  const client = new DingTalkClient("TestBot");

  it("TC-MSG-UNIT-016 | 发送异常内部 catch", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));
    await expect(client.sendTextMessage("webhook", "hello")).resolves.toBeUndefined();
  });

  it("sendMessage 正常发送", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true } as any);
    await expect(client.sendMessage("webhook", { title: "t", text: "hello" })).resolves.toBeUndefined();
  });

  it("sendTextMessage 正常发送", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true } as any);
    await expect(client.sendTextMessage("webhook", "hello")).resolves.toBeUndefined();
  });
});
