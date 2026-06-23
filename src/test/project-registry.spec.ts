import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ProjectRegistry } from "../project-registry.js";

vi.mock("../logger.js", () => ({
  Logger: class {
    info = vi.fn();
    error = vi.fn();
    warn = vi.fn();
    debug = vi.fn();
  },
}));

describe("ProjectRegistry", () => {
  const tmpDir = path.resolve("/tmp", `registry-test-${Date.now()}`);
  const configPath = path.join(tmpDir, "projects.json");

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("TC-SVR-UNIT-001 | 加载合法 JSON 返回项目数组", () => {
    fs.writeFileSync(configPath, JSON.stringify([
      { id: "proj1", name: "Project1", path: tmpDir },
    ]), "utf-8");
    const registry = new ProjectRegistry(configPath, [tmpDir]);
    expect(registry.list()).toHaveLength(1);
  });

  it("TC-SVR-UNIT-002 | 重复 id 检测，跳过重复项保留第一个", () => {
    fs.writeFileSync(configPath, JSON.stringify([
      { id: "proj1", name: "Project1", path: tmpDir },
      { id: "proj1", name: "Project2", path: tmpDir },
    ]), "utf-8");
    const registry = new ProjectRegistry(configPath, [tmpDir]);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].name).toBe("Project1");
  });

  it("TC-SVR-UNIT-003 | 重复 name 检测，跳过重复项保留第一个", () => {
    fs.writeFileSync(configPath, JSON.stringify([
      { id: "proj1", name: "SameName", path: tmpDir },
      { id: "proj2", name: "SameName", path: tmpDir },
    ]), "utf-8");
    const registry = new ProjectRegistry(configPath, [tmpDir]);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].id).toBe("proj1");
  });

  it("TC-SVR-UNIT-017 | 混合场景：部分有效 + 部分无效（目录不存在）", () => {
    const nonExistentDir = path.join(tmpDir, "nonexistent");
    fs.writeFileSync(configPath, JSON.stringify([
      { id: "valid1", name: "Valid1", path: tmpDir },
      { id: "invalid1", name: "Invalid1", path: nonExistentDir },
      { id: "valid2", name: "Valid2", path: tmpDir },
    ]), "utf-8");
    const registry = new ProjectRegistry(configPath, [tmpDir]);
    expect(registry.list()).toHaveLength(2);
    expect(registry.find("valid1")).toBeDefined();
    expect(registry.find("valid2")).toBeDefined();
    expect(registry.find("invalid1")).toBeUndefined();
  });

  it("TC-SVR-UNIT-004 | 非绝对路径，load 后列表为空", () => {
    fs.writeFileSync(configPath, JSON.stringify([
      { id: "proj1", name: "Project1", path: "relative/path" },
    ]), "utf-8");
    const registry = new ProjectRegistry(configPath, [tmpDir]);
    expect(registry.list()).toHaveLength(0);
  });

  it("TC-SVR-UNIT-005 | 路径不在 ALLOWED_ROOTS，load 后列表为空", () => {
    fs.writeFileSync(configPath, JSON.stringify([
      { id: "proj1", name: "Project1", path: "/some/outside/path" },
    ]), "utf-8");
    const registry = new ProjectRegistry(configPath, ["/allowed/root"]);
    expect(registry.list()).toHaveLength(0);
  });

  it("TC-SVR-UNIT-015 | 项目目录内容校验 — 存在有效文件", () => {
    fs.writeFileSync(configPath, JSON.stringify([
      { id: "proj1", name: "Project1", path: tmpDir },
    ]), "utf-8");
    fs.writeFileSync(path.join(tmpDir, ".git"), "", "utf-8");
    const registry = new ProjectRegistry(configPath, [tmpDir]);
    expect(registry.list()).toHaveLength(1);
  });

  it("TC-SVR-UNIT-016 | 项目目录内容校验 — 无有效文件不阻塞", () => {
    fs.writeFileSync(configPath, JSON.stringify([
      { id: "proj1", name: "Project1", path: tmpDir },
    ]), "utf-8");
    const registry = new ProjectRegistry(configPath, [tmpDir]);
    expect(registry.list()).toHaveLength(1);
  });

  it("TC-SVR-INTG-004 | load -> findById -> findByName 完整链路", () => {
    fs.writeFileSync(configPath, JSON.stringify([
      { id: "proj1", name: "Project1", path: tmpDir },
      { id: "proj2", name: "Project2", path: tmpDir },
    ]), "utf-8");
    const registry = new ProjectRegistry(configPath, [tmpDir]);
    expect(registry.find("proj1")?.name).toBe("Project1");
    expect(registry.find("Project2")?.id).toBe("proj2");
  });

  it("TC-SVR-INTG-005 | load 失败时 find 返回 undefined", () => {
    const registry = new ProjectRegistry("/nonexistent/path.json", [tmpDir]);
    expect(registry.find("anything")).toBeUndefined();
  });
});
