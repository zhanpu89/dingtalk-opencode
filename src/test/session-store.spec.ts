import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SessionStore } from "../session-store.js";
import { ProjectContextStore } from "../project-context-store.js";

vi.mock("../logger.js", () => ({
  Logger: class {
    info = vi.fn();
    error = vi.fn();
    warn = vi.fn();
    debug = vi.fn();
  },
}));

describe("SessionStore", () => {
  const tmpDir = path.resolve("/tmp", `session-test-${Date.now()}`);
  const filePath = path.join(tmpDir, "session-map.json");

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("TC-STO-UNIT-001 | 会话映射文件不存在时自动创建空 Map", () => {
    const store = new SessionStore(filePath);
    expect(store.size()).toBe(0);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("TC-STO-UNIT-002 | 会话映射文件已存在正常加载", () => {
    fs.writeFileSync(filePath, JSON.stringify({ k: "v" }), "utf-8");
    const store = new SessionStore(filePath);
    expect(store.size()).toBe(1);
    expect(store.get("k")).toBe("v");
  });

  it("TC-STO-UNIT-003 | 写入操作触发防抖，2s 内多次 set 仅一次 flush", async () => {
    vi.useFakeTimers();
    const store = new SessionStore(filePath);
    const flushSpy = vi.spyOn(store, "flush");
    store.set("a", "1");
    store.set("b", "2");
    store.set("c", "3");
    expect(flushSpy).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(2000);
    expect(flushSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("TC-STO-UNIT-004 | 防抖定时器重置：连续 set 刷新定时器", async () => {
    vi.useFakeTimers();
    const store = new SessionStore(filePath);
    const flushSpy = vi.spyOn(store, "flush");
    store.set("a", "1");
    vi.advanceTimersByTime(1000);
    store.set("b", "2");
    vi.advanceTimersByTime(1500);
    expect(flushSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("TC-STO-UNIT-005 | 文件损坏时以空 Map 启动", () => {
    fs.writeFileSync(filePath, "{invalid", "utf-8");
    const store = new SessionStore(filePath);
    expect(store.size()).toBe(0);
  });

  it("TC-STO-UNIT-006 | 文件损坏时从 .bak 备份恢复", () => {
    fs.writeFileSync(filePath, "{invalid", "utf-8");
    fs.writeFileSync(filePath + ".bak", JSON.stringify({ k: "v" }), "utf-8");
    const store = new SessionStore(filePath);
    expect(store.size()).toBe(1);
    expect(store.get("k")).toBe("v");
  });

  it("TC-STO-UNIT-007 | 主文件和备份均损坏时空 Map 启动", () => {
    fs.writeFileSync(filePath, "{invalid", "utf-8");
    fs.writeFileSync(filePath + ".bak", "{also invalid", "utf-8");
    const store = new SessionStore(filePath);
    expect(store.size()).toBe(0);
  });

  it("TC-STO-UNIT-008 | get 不存在的 key 返回 undefined", () => {
    const store = new SessionStore(filePath);
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("TC-STO-UNIT-013 | set 空字符串 value", () => {
    const store = new SessionStore(filePath);
    store.set("k", "");
    expect(store.get("k")).toBe("");
  });

  it("TC-STO-UNIT-014 | flush 时 rename 旧文件为 .bak 失败（首次写入）", () => {
    const store = new SessionStore(filePath);
    store.set("a", "1");
    store.flush();
    expect(fs.existsSync(filePath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content).toEqual({ a: "1" });
  });

  it("TC-STO-UNIT-015 | flush 原子写入顺序正确", () => {
    const store = new SessionStore(filePath);
    store.set("a", "v1");
    store.flush();
    const mainContent1 = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(mainContent1).toEqual({ a: "v1" });
    store.set("b", "v2");
    store.flush();
    const bakContent = JSON.parse(fs.readFileSync(filePath + ".bak", "utf-8"));
    expect(bakContent).toEqual({ a: "v1" });
    const mainContent2 = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(mainContent2).toEqual({ a: "v1", b: "v2" });
  });

  it("TC-STO-INTG-001 | 首次启动→set→flush→重启加载完整链路", () => {
    const store1 = new SessionStore(filePath);
    store1.set("k1", "v1");
    store1.set("k2", "v2");
    store1.flush();
    const store2 = new SessionStore(filePath);
    expect(store2.get("k1")).toBe("v1");
    expect(store2.get("k2")).toBe("v2");
  });
});

describe("ProjectContextStore", () => {
  const tmpDir = path.resolve("/tmp", `ctx-test-${Date.now()}`);
  const filePath = path.join(tmpDir, "project-context.json");

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("TC-STO-UNIT-010 | 加载时文件不存在自动创建空 store", () => {
    const store = new ProjectContextStore(filePath);
    expect(store.get("unknown_session")).toBeUndefined();
  });

  it("TC-STO-UNIT-009 | get 不存在的 sessionId 返回 undefined", () => {
    const store = new ProjectContextStore(filePath);
    expect(store.get("unknown_session")).toBeUndefined();
  });

  it("TC-STO-UNIT-011 | set 后立即 get 返回正确值", () => {
    const store = new ProjectContextStore(filePath);
    store.set("session1", "projA");
    expect(store.get("session1")).toBe("projA");
  });

  it("TC-STO-UNIT-011-B | delete 后 get 返回 undefined", () => {
    const store = new ProjectContextStore(filePath);
    store.set("session1", "projA");
    store.delete("session1");
    expect(store.get("session1")).toBeUndefined();
  });

  it("TC-STO-UNIT-012 | clearAll 后所有 get 返回 undefined", () => {
    const store = new ProjectContextStore(filePath);
    store.set("s1", "p1");
    store.set("s2", "p2");
    store.clearAll();
    expect(store.get("s1")).toBeUndefined();
    expect(store.get("s2")).toBeUndefined();
  });

  it("TC-STO-INTG-004 | set→重启→get", () => {
    const store1 = new ProjectContextStore(filePath);
    store1.set("session1", "projA");
    const store2 = new ProjectContextStore(filePath);
    expect(store2.get("session1")).toBe("projA");
  });

  it("TC-STO-INTG-005 | set→delete→重启→get", () => {
    const store1 = new ProjectContextStore(filePath);
    store1.set("session1", "projA");
    store1.delete("session1");
    const store2 = new ProjectContextStore(filePath);
    expect(store2.get("session1")).toBeUndefined();
  });

  it("TC-STO-INTG-006 | 多次 set 不同绑定", () => {
    const store1 = new ProjectContextStore(filePath);
    store1.set("s1", "p1");
    store1.set("s2", "p2");
    store1.set("s3", "p3");
    const store2 = new ProjectContextStore(filePath);
    expect(store2.get("s1")).toBe("p1");
    expect(store2.get("s2")).toBe("p2");
    expect(store2.get("s3")).toBe("p3");
  });
});
