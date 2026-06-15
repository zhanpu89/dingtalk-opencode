# OpenCode API 客户端 测试用例

---
文档编号：TC-20260615-002
版本：v1.0.0
状态：🟡 草稿
创建日期：2026-06-15
最后更新：2026-06-15
作者：AI-Tester
关联文档：
  - 详设文档：docs/design.md（§2.2 OpenCode API 客户端）
---

## 1. 测试范围

- **被测模块**：OpenCode API 客户端（`src/opencode.ts`——HTTP API 封装、流式消息发送、session 管理）
- **被测接口**：
  - `sendMessage(sessionId, text, signal?)`
  - `sessionExists(sessionId)`
  - `createSession(title?)`
  - `shareSession(sessionId)`
  - `health()`
  - `extractSummary(response)`
- **用例总数**：19 条（单元测试 18 + 集成测试 1）
- **关联业务规则**：BR-OAPI-001~BR-OAPI-015
- **关联代码评审报告**：无

---

## 2. 全局前置条件

1. Mock `fetch` 全局函数
2. Mock `Logger`
3. 测试不依赖真实 OpenCode 服务

---

## 3. 单元测试用例（UNIT）

### 业务规则覆盖用例

| 用例 ID | 用例标题 | 优先级 | 关联规则 | 前置条件 | 测试步骤 | 预期结果 | 备注 |
|--------|---------|-------|---------|---------|---------|---------|-----|
| TC-OAPI-UNIT-001 | sendMessage 正常流式响应——拼接所有 chunk | P0 | BR-OAPI-001 | Mock fetch 返回 Response 含多个 chunk | 1. Mock fetch 返回 stream，分 2 个 chunk 返回 `{"parts":[]}` 2. 调用 `sendMessage(sid, "hi", signal)` | 返回正确 JSON 对象，所有 chunk 拼接无乱码 | |
| TC-OAPI-UNIT-002 | sendMessage Phase 1 超时——AbortError 传播 | P0 | BR-OAPI-002 | Mock fetch 被 timeout 中止 | 1. Mock fetch 不 resolve, AbortController 触发 timeout 2. 调用 `sendMessage` | 抛出 Error 含 "opencode API timeout"，timer 已清理 | |
| TC-OAPI-UNIT-003 | sendMessage 外部 AbortSignal 触发流中断 | P0 | BR-OAPI-003 | Mock fetch 返回 stream；外部 AbortController 稍后 abort | 1. 创建外部 AbortController 2. 开始 sendMessage 3. 外部 controller.abort() | 流读取中断，抛出 AbortError | |
| TC-OAPI-UNIT-004 | sendMessage 外部 signal 在调用前已 abort | P1 | BR-OAPI-004 | 创建外部 AbortController 并立即 abort | 1. 外部 controller.abort() 2. 调用 `sendMessage` 传入已 abort 的 signal | fetch 立即被拒绝（不发送请求） | |
| TC-OAPI-UNIT-005 | sendMessage HTTP 非 200 响应 | P1 | BR-OAPI-005 | Mock fetch 返回 500 状态码 | 1. Mock fetch 返回 `{status: 500, ok: false}` 2. 调用 `sendMessage` | 抛出 Error 含 "opencode API error 500" 和响应体 | |
| TC-OAPI-UNIT-006 | sendMessage HTTP 非 200（Phase 2 后）——理论上不可能但保留 | P2 | BR-OAPI-006 | Mock fetch 返回 ok 但流中出错 | 1. Mock fetch 返回 `{ok: true}` 但 body.getReader 不提供 | 流读取正常完成，返回 JSON.parse 结果 | |
| TC-OAPI-UNIT-007 | sessionExists——session 存在返回 true | P1 | BR-OAPI-007 | Mock `request` 返回 session 列表含目标 id | 1. Mock GET /session 返回 `[{id: "sid-1"}, {id: "sid-2"}]` 2. 调用 `sessionExists("sid-1")` | 返回 true | |
| TC-OAPI-UNIT-008 | sessionExists——session 不存在返回 false | P1 | BR-OAPI-008 | Mock `request` 返回 session 列表不含目标 id | 1. Mock GET /session 返回 `[{id: "sid-2"}]` 2. 调用 `sessionExists("sid-1")` | 返回 false | |
| TC-OAPI-UNIT-009 | sessionExists——API 错误返回 null | P1 | BR-OAPI-009 | Mock `request` 抛出异常 | 1. Mock GET /session 抛出异常 2. 调用 `sessionExists("sid-1")` | 返回 null | |
| TC-OAPI-UNIT-010 | createSession——新 session 调用 POST /session | P1 | BR-OAPI-010 | Mock `request`: GET /session 返回空列表 | 1. Mock GET /session 返回 `[]` 2. 调用 `createSession("标题")` | GET /session 被调用 → POST /session 被调用，传入 `{title: "标题"}` | |
| TC-OAPI-UNIT-011 | createSession——已有同名复用 | P1 | BR-OAPI-011 | Mock `request`: GET /session 返回含同标题 session | 1. Mock GET /session 返回 `[{id: "existing", title: "标题"}]` 2. 调用 `createSession("标题")` | GET /session 被调用，POST /session 不被调用，返回已有 session | |
| TC-OAPI-UNIT-012 | shareSession——成功返回 shareURL | P1 | BR-OAPI-012 | Mock `request` 返回 `{id: "sid", shareURL: "https://..."}` | 1. Mock POST /session/{id}/share 返回含 shareURL 的响应 2. 调用 `shareSession("sid")` | 返回 "https://..." | |
| TC-OAPI-UNIT-013 | shareSession——失败返回 null 并日志 warn | P1 | BR-OAPI-013 | Mock `request` 抛出异常 | 1. Mock POST /session/{id}/share 抛出异常 2. 调用 `shareSession("sid")` | 返回 null，log.warn 被调用 | |
| TC-OAPI-UNIT-014 | health——服务正常返回 true | P1 | BR-OAPI-014 | Mock `request` 返回 `{healthy: true}` | 1. Mock GET /global/health 正常返回 2. 调用 `health()` | 返回 true | |
| TC-OAPI-UNIT-015 | health——服务异常返回 false | P1 | BR-OAPI-015 | Mock `request` 抛出异常 | 1. Mock GET /global/health 抛出异常 2. 调用 `health()` | 返回 false | |

### 边界值用例

| 用例 ID | 用例标题 | 优先级 | 边界描述 | 前置条件 | 测试步骤 | 预期结果 | 备注 |
|--------|---------|-------|---------|---------|---------|---------|-----|
| TC-OAPI-UNIT-016 | extractSummary——空 parts | P2 | 无任何 text/tool 类型 parts | 传入 `{parts: []}` | 1. 调用 `extractSummary({parts: []})` | summary="(无文本回复)"，changedFiles=[]，toolNames=[]，fullLength=0 | |

### 分支覆盖用例

| 用例 ID | 用例标题 | 优先级 | 对应分支 | 前置条件 | 测试步骤 | 预期结果 | 备注 |
|--------|---------|-------|---------|---------|---------|---------|-----|
| TC-OAPI-UNIT-017 | request——已配置 auth 时携带 Authorization 头 | P2 | `this.authHeader` 非 null | 构造时传入有 password 的 config | 1. Mock fetch 2. 调用 `request("GET", "/session")` | fetch 调用 headers 含 `Authorization: Basic...` | |
| TC-OAPI-UNIT-018 | request——未配置 auth 时不携带 Authorization 头 | P2 | `this.authHeader` 为 null | 构造时传入无 password 的 config | 1. Mock fetch 2. 调用 `request("GET", "/session")` | fetch 调用 headers 不含 `Authorization` | |

---

## 4. 集成测试用例（INTG）

### 业务流程用例（跨模块链路）

| 用例 ID | 用例标题 | 优先级 | 流程步骤 | 预期最终状态 | 备注 |
|--------|---------|-------|---------|------------|-----|
| TC-OAPI-INTG-001 | sendMessage 完整流式流程——Phase 1 + Phase 2 | P0 | 1. Mock fetch 返回 200 + stream body 含多 chunk 2. 调用 `sendMessage` 3. 验证 fetch URL = `/session/{sid}/message` 4. 验证 POST body = `{parts: [{type: "text", text}]}` 5. 验证返回值为正确 JSON | fetch 被调用一次，返回值正确解析 | |

---

## 5. 安全测试用例（SEC）

本模块无安全测试用例（模块为 HTTP API 调用封装，认证凭据由配置注入，HTTP 请求使用标准 fetch API）

---

## 6. 性能测试用例（PERF）

本模块无性能测试用例（模块为 HTTP 客户端封装，性能取决于上游 OpenCode 服务）

---

## 7. 前端测试用例（FE）

本模块无前端测试用例（纯后端项目）

---

## 8. 用例统计

| 类型 | 数量 | 优先级分布 |
|-----|-----|---------|
| 单元测试（UNIT） | 18 | P0: 4 / P1: 12 / P2: 2 |
| 集成测试（INTG） | 1 | P0: 1 / P1: 0 / P2: 0 |
| 安全测试（SEC） | 0 | - |
| 性能测试（PERF） | 0 | - |
| 前端测试（FE） | 0 | - |
| **合计** | **19** | P0: 5 / P1: 12 / P2: 2 |

其中 `[评审专项]` 用例：0 条

---

## 变更记录

| 版本 | 日期 | 作者 | 变更说明 |
|-----|------|-----|---------|
| v1.0.0 | 2026-06-15 | AI-Tester | 初始版本，首次生成 |
