import { describe, it, expect, vi, beforeEach } from "vitest";

describe("loadConfig", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("TC-SVR-UNIT-012 | 环境变量缺失时使用默认值", async () => {
    const origEnv = { ...process.env };
    delete process.env.ALLOWED_PROJECT_ROOTS;
    delete process.env.OPENCODE_SERVER_URL;
    const { loadConfig } = await import("../config.js");
    const config = loadConfig();
    expect(config.opencodeServerUrl).toBe("http://localhost:4096");
    expect(config.allowedProjectRoots).toEqual([]);
    Object.assign(process.env, origEnv);
  });

  it("从环境变量正确加载配置", async () => {
    const origEnv = { ...process.env };
    process.env.OPENCODE_SERVER_URL = "http://test:1234";
    process.env.ALLOWED_PROJECT_ROOTS = "/root1,/root2";
    process.env.RATE_LIMIT_MAX = "50";
    const { loadConfig } = await import("../config.js");
    const config = loadConfig();
    expect(config.opencodeServerUrl).toBe("http://test:1234");
    expect(config.allowedProjectRoots).toEqual(["/root1", "/root2"]);
    expect(config.rateLimitMax).toBe(50);
    Object.assign(process.env, origEnv);
  });
});
