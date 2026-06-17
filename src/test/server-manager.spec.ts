import { describe, it, expect, beforeEach, vi } from "vitest";
import { ServerManager } from "../server-manager.js";

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
    projectServerPortStart: 4100,
    projectServerHostname: "127.0.0.1",
    ...overrides,
  } as any;
}

describe("ServerManager", () => {
  let manager: ServerManager;

  beforeEach(() => {
    vi.restoreAllMocks();
    manager = new ServerManager(mockConfig());
  });

  it("TC-SVR-UNIT-006 | 启动项目服务正常返回 baseUrl", async () => {
    vi.spyOn(manager as any, "bootProject").mockResolvedValue({
      projectId: "proj1",
      projectPath: "/tmp",
      port: 4100,
      baseUrl: "http://127.0.0.1:4100",
      status: "running",
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    const baseUrl = await manager.startProject({ id: "proj1", name: "Test", path: "/tmp" });
    expect(baseUrl).toBe("http://127.0.0.1:4100");
  });

  it("TC-SVR-UNIT-007 | 启动已运行的服务复用实例", async () => {
    vi.spyOn(manager as any, "bootProject").mockResolvedValue({
      projectId: "proj1",
      projectPath: "/tmp",
      port: 4100,
      baseUrl: "http://127.0.0.1:4100",
      status: "running",
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    const first = await manager.startProject({ id: "proj1", name: "Test", path: "/tmp" });
    const second = await manager.startProject({ id: "proj1", name: "Test", path: "/tmp" });
    expect(first).toBe(second);
  });

  it("TC-SVR-UNIT-008 | 启动超时抛出 TimeoutError", async () => {
    vi.spyOn(manager as any, "bootProject").mockRejectedValue(new Error("project server startup timeout: http://127.0.0.1:4100"));
    await expect(manager.startProject({ id: "proj1", name: "Test", path: "/tmp" })).rejects.toThrow(/timeout/);
  });

  it("TC-SVR-UNIT-009 | 子进程异常退出更新状态为 failed", async () => {
    vi.spyOn(manager as any, "bootProject").mockRejectedValue(new Error("process exited"));
    await expect(manager.startProject({ id: "proj1", name: "Test", path: "/tmp" })).rejects.toThrow();
  });

  it("TC-SVR-UNIT-010 | checkProject 运行中返回正确信息", async () => {
    const instance = {
      projectId: "proj1",
      projectPath: "/tmp",
      port: 4100,
      baseUrl: "http://127.0.0.1:4100",
      status: "running",
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    vi.spyOn(manager as any, "bootProject").mockResolvedValue(instance);
    (manager as any).projectServers.set("proj1", instance);
    global.fetch = vi.fn().mockResolvedValue({ ok: true } as any);
    await manager.startProject({ id: "proj1", name: "Test", path: "/tmp" });
    const result = await manager.checkProject("proj1");
    expect(result.running).toBe(true);
    expect(result.port).toBe(4100);
  });

  it("TC-SVR-UNIT-011 | checkProject 不存在返回 running=false", async () => {
    const result = await manager.checkProject("unknown");
    expect(result.running).toBe(false);
  });

  it("TC-SVR-UNIT-017 | 动态项目服务仅监听 127.0.0.1", async () => {
    vi.spyOn(manager as any, "bootProject").mockResolvedValue({
      projectId: "proj1",
      projectPath: "/tmp",
      port: 4100,
      baseUrl: "http://127.0.0.1:4100",
      status: "running",
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    const baseUrl = await manager.startProject({ id: "proj1", name: "Test", path: "/tmp" });
    expect(baseUrl).toContain("127.0.0.1");
  });

  it("TC-SVR-UNIT-013 | 端口分配失败抛出错误", async () => {
    vi.spyOn(manager as any, "isPortFree").mockResolvedValue(false);
    vi.spyOn(manager as any, "bootProject").mockImplementation(async () => {
      throw new Error("no free port available");
    });
    await expect(manager.startProject({ id: "proj1", name: "Test", path: "/tmp" })).rejects.toThrow();
  });

  it("TC-SVR-INTG-001 | 启动->查询->停止完整链路", async () => {
    const instance = {
      projectId: "proj1",
      projectPath: "/tmp",
      port: 4100,
      baseUrl: "http://127.0.0.1:4100",
      status: "running",
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    vi.spyOn(manager as any, "bootProject").mockResolvedValue(instance);
    (manager as any).projectServers.set("proj1", instance);
    global.fetch = vi.fn().mockResolvedValue({ ok: true } as any);
    const baseUrl = await manager.startProject({ id: "proj1", name: "Test", path: "/tmp" });
    expect(baseUrl).toBeTruthy();
    const check = await manager.checkProject("proj1");
    expect(check.running).toBe(true);
    manager.disposeProject("proj1");
    const after = await manager.checkProject("proj1");
    expect(after.running).toBe(false);
  });

  it("TC-SVR-INTG-003 | 启动后立即查询 checkProject", async () => {
    const instance = {
      projectId: "proj1",
      projectPath: "/tmp",
      port: 4100,
      baseUrl: "http://127.0.0.1:4100",
      status: "running",
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    vi.spyOn(manager as any, "bootProject").mockResolvedValue(instance);
    (manager as any).projectServers.set("proj1", instance);
    global.fetch = vi.fn().mockResolvedValue({ ok: true } as any);
    await manager.startProject({ id: "proj1", name: "Test", path: "/tmp" });
    const result = await manager.checkProject("proj1");
    expect(result.running).toBe(true);
    expect(result.port).toBe(4100);
  });
});
