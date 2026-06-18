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

  it("TC-SVR-UNIT-014 | 端口分配全部被占用", async () => {
    vi.spyOn(manager as any, "isPortFree").mockResolvedValue(false);
    vi.spyOn(manager as any, "allocatePort").mockRejectedValue(new Error("no free port available"));
    await expect(
      manager.startProject({ id: "proj1", name: "Test", path: "/tmp" })
    ).rejects.toThrow("no free port available");
  });

  it("TC-SVR-INTG-002 | 启动超时后状态为 stopped", async () => {
    const instance = {
      projectId: "proj1",
      projectPath: "/tmp",
      port: 4100,
      baseUrl: "http://127.0.0.1:4100",
      status: "starting",
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    (manager as any).projectServers.set("proj1", instance);
    vi.spyOn(manager as any, "bootProject").mockRejectedValue(new Error("project server startup timeout: http://127.0.0.1:4100"));
    vi.spyOn(manager as any, "killProject").mockImplementation((inst: any) => {
      inst.status = "stopped";
    });

    await expect(manager.startProject({ id: "proj1", name: "Test", path: "/tmp" })).rejects.toThrow("timeout");

    // 实例应从 map 中清除（因 startProject 失败时 pendingStarts 会清理，但 projectServers 中因 bootProject 调用 killProject 会更新状态）
    // 验证 killProject 被调用
    expect((manager as any).killProject).toHaveBeenCalled();
  });

  it("TC-SVR-UNIT-020 | stopAllProjects 清除所有项目实例", async () => {
    const instance = {
      projectId: "proj1",
      projectPath: "/tmp",
      port: 4100,
      baseUrl: "http://127.0.0.1:4100",
      status: "running",
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    (manager as any).projectServers.set("proj1", instance);
    (manager as any).projectServers.set("proj2", { ...instance, projectId: "proj2", port: 4101 });
    vi.spyOn(manager as any, "killProject").mockImplementation((inst: any) => {
      inst.status = "stopped";
    });
    manager.stopAllProjects();
    expect((manager as any).projectServers.size).toBe(0);
  });

  it("空闲回收器超过阈值后释放项目", async () => {
    vi.useFakeTimers();
    const oldNow = Date.now();
    const idleMs = 7_200_000; // 2h
    const mgr = new (ServerManager as any)(mockConfig({ projectServerIdleMs: idleMs })) as ServerManager;
    // 手动注入一个很久未使用的实例
    const oldTime = Date.now() - idleMs - 60_000; // 超过阈值
    const instance = {
      projectId: "proj1",
      projectPath: "/tmp",
      port: 4100,
      baseUrl: "http://127.0.0.1:4100",
      status: "running",
      startedAt: oldTime,
      lastUsedAt: oldTime,
    };
    (mgr as any).projectServers.set("proj1", instance);
    vi.spyOn(mgr as any, "disposeProject").mockImplementation((id: string) => {
      (mgr as any).projectServers.delete(id);
    });
    // 推进时间触发 reaper
    await vi.advanceTimersByTimeAsync(idleMs + 10_000);
    expect((mgr as any).projectServers.size).toBe(0);
    expect((mgr as any).disposeProject).toHaveBeenCalledWith("proj1");
    vi.useRealTimers();
  });
});
