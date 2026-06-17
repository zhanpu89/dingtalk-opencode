# OpenCode API客户端 测试用例

---
文档编号：TC-20260617-003
版本：v1.0.0
状态：🟡 草稿
创建日期：2026-06-17
最后更新：2026-06-17
作者：AI-Tester
关联文档：
  - 详设文档：doc/detailed/OpenCode API客户端.md
  - 项目规则：doc/detailed/项目规则.md
---

## 1. 测试范围

- **被测模块**：OpenCode API客户端（sendMessage + sessionExists + createSession + shareSession + health）
- **被测接口**：5 个（sendMessage/sessionExists/createSession/shareSession/health）
- **用例总数**：24 条（单元测试 19 + 集成测试 5 + 安全测试 0 + 性能测试 0）
- **关联业务规则**：OPC-REG-01 ~ OPC-REG-07
- **关联代码评审报告**：无
- **AC 追溯**：
  - AC-AI处理-01（异常自动重试）→ TC-OPC-UNIT-003, TC-OPC-UNIT-004
  - AC-会话管理-01（首次自动创建会话）→ TC-OPC-UNIT-010
  - AC-会话管理-02（复用已有会话）→ TC-OPC-UNIT-011

---

## 2. 全局前置条件

1. 所有 HTTP 调用使用 Mock（fetch）隔离
2. AbortSignal 使用 jest 模拟
3. TextDecoder 流解码使用 Mock

---

## 3. 单元测试用例（UNIT）

### 业务规则覆盖用例

| 用例 ID | 用例标题 | 优先级 | 关联规则 | 前置条件 | 测试步骤 | 预期结果 | 备注 |
|--------|---------|-------|---------|---------|---------|---------|-----|
| TC-OPC-UNIT-001 | sendMessage 正常流式响应返回完整结果 | P0 | OPC-REG-01 | Mock fetch 返回 200 + 流数据 | 1. 调用 sendMessage("sid", "hello") | 返回拼接后的完整 JSON 字符串 | |
| TC-OPC-UNIT-002 | sendMessage 分块到达正确拼接 | P1 | OPC-REG-01 | Mock fetch 返回多个 chunk | 1. 调用 sendMessage("sid", "hello") | 拼接后 JSON.parse 正确 | 验证跨 chunk 拼接 |
| TC-OPC-UNIT-003 | sendMessage Phase 1 超时抛出 AbortError | P1 | OPC-REG-02 | 设置短 timeoutMs | 1. 调用 sendMessage 2. 超时触发 | 抛出 AbortError | |
| TC-OPC-UNIT-004 | sendMessage 外部 AbortSignal 触发中止 | P1 | OPC-REG-03 | Phase 2 中触发外部 signal | 1. 调用 sendMessage 2. 触发外部 signal | 流中断，抛出 AbortError | |
| TC-OPC-UNIT-005 | sendMessage 外部 signal 调用前已 abort | P1 | OPC-REG-03 | 已 abort 的 signal | 1. 传入已 abort 的 signal 2. 调用 sendMessage | fetch 立即拒绝 | |
| TC-OPC-UNIT-006 | sendMessage HTTP 非 200 抛出 Error | P1 | — | Mock fetch 返回 500 | 1. 调用 sendMessage | throw Error，包含 status 和 body | |
| TC-OPC-UNIT-007 | sessionExists 存在返回 true | P0 | OPC-REG-04 | Mock fetch 返回 body.id | 1. 调用 sessionExists("sid") | 返回 true | |
| TC-OPC-UNIT-008 | sessionExists 不存在返回 false | P0 | OPC-REG-04 | Mock fetch 返回 404 | 1. 调用 sessionExists("sid") | 返回 false | |
| TC-OPC-UNIT-009 | sessionExists API 错误返回 null | P1 | OPC-REG-04 | Mock fetch throw | 1. 调用 sessionExists("sid") | 返回 null，不抛异常 | |
| TC-OPC-UNIT-010 | createSession 新建（同名不存在） | P0 | OPC-REG-05 | Mock GET 返回空，POST 返回新 id | 1. 调用 createSession("name") | POST 被调用，返回新 id | |
| TC-OPC-UNIT-011 | createSession 复用（同名已存在） | P0 | OPC-REG-05 | Mock GET 返回 body.id | 1. 调用 createSession("name") | GET 查到并复用，POST 不被调用 | |
| TC-OPC-UNIT-012 | shareSession 失败返回 null | P1 | OPC-REG-06 | Mock API 异常 | 1. 调用 shareSession("sid") | 返回 null，日志 warn | |
| TC-OPC-UNIT-013 | health 正常返回 true | P0 | OPC-REG-07 | Mock fetch 返回 200 OK | 1. 调用 health() | 返回 true | |
| TC-OPC-UNIT-014 | health 异常返回 false | P1 | OPC-REG-07 | Mock fetch 返回 500 或 throw | 1. 调用 health() | 返回 false，不抛异常 | |

### 边界值用例

| 用例 ID | 用例标题 | 优先级 | 边界描述 | 前置条件 | 测试步骤 | 预期结果 | 备注 |
|--------|---------|-------|---------|---------|---------|---------|-----|
| TC-OPC-UNIT-015 | sendMessage 空消息内容 | P2 | 空字符串消息 | Mock fetch 返回 200 | 1. 调用 sendMessage("sid", "") | 正常发送，空消息传给 API | |
| TC-OPC-UNIT-018 | sendMessage 超长消息（10000 字符） | P2 | 消息长度上限 | Mock fetch 返回 200 | 1. 调用 sendMessage("sid", "x".repeat(10000)) | 正常发送，API 收到完整消息 | 边界值补充 |
| TC-OPC-UNIT-019 | sessionId 为超长字符串（512 字符） | P2 | sessionId 长度上限 | Mock fetch 返回 200 | 1. 调用 sessionExists("s".repeat(512)) | 正常处理，返回 true/false | 边界值补充 |

### 分支覆盖用例

| 用例 ID | 用例标题 | 优先级 | 对应分支 | 前置条件 | 测试步骤 | 预期结果 | 备注 |
|--------|---------|-------|---------|---------|---------|---------|-----|
| TC-OPC-UNIT-016 | createSession GET 返回非 200 时走新建分支 | P1 | GET 失败 -> POST 新建 | Mock GET 返回 500 | 1. 调用 createSession("name") | POST 被调用，返回新 id | |
| TC-OPC-UNIT-017 | shareSession 成功返回 URL | P1 | shareSession 成功 | Mock 返回 shareUrl | 1. 调用 shareSession("sid") | 返回 URL 字符串 | |

---

## 4. 集成测试用例（INTG）

### sendMessage 完整流程

| 用例 ID | 用例标题 | 优先级 | 前置条件 | 请求参数 | 预期状态码 | 预期响应体关键字段 | 备注 |
|--------|---------|-------|---------|---------|----------|----------------|-----|
| TC-OPC-INTG-001 | sendMessage 正常流 -> 解析完整 | P0 | Mock fetch 返回完整流 | sendMessage("sid", "hello") | — | 返回完整 JSON 字符串，可 JSON.parse | |
| TC-OPC-INTG-002 | sendMessage 超时 -> AbortError | P1 | 短 timeout | sendMessage("sid", "hello") | — | 抛出 AbortError，timer 清理 | |

### Session 生命周期完整流程

| 用例 ID | 用例标题 | 优先级 | 前置条件 | 请求参数 | 预期状态码 | 预期响应体关键字段 | 备注 |
|--------|---------|-------|---------|---------|----------|----------------|-----|
| TC-OPC-INTG-003 | createSession -> sessionExists -> sendMessage 完整链路 | P0 | Mock 所有 API 正常 | createSession -> sessionExists -> sendMessage | — | 创建成功 -> 存在为 true -> 消息发送成功 | |
| TC-OPC-INTG-004 | createSession 复用 -> sessionExists | P1 | Mock GET 返回已有 session | createSession("name") -> sessionExists("id") | — | 复用成功 -> 存在为 true | |
| TC-OPC-INTG-005 | health -> sendMessage 服务可用链路 | P1 | Mock health 200 + sendMessage 200 | health() -> sendMessage | — | health 返回 true -> sendMessage 成功 | |

---

## 5. 安全测试用例（SEC）

本模块无安全测试用例（OpenCode API 通过内网 HTTP 调用 127.0.0.1，认证由 OpenCode 服务管理，本模块透传）。

---

## 6. 性能测试用例（PERF）

本模块无性能测试用例（sendMessage Phase 1 P95 <= 5s，其余接口为偶发调用或看门狗周期性调用，性能风险低）。

---

## 7. 前端测试用例（FE）

本模块为后端模块，无前端测试用例。

---

## 8. 用例统计

| 类型 | 数量 | 优先级分布 |
|-----|-----|---------|
| 单元测试（UNIT） | 19 | P0: 6 / P1: 10 / P2: 3 |
| 集成测试（INTG） | 5 | P0: 2 / P1: 3 / P2: 0 |
| 安全测试（SEC） | 0 | P0: 0 / P1: 0 / P2: 0 |
| 性能测试（PERF） | 0 | P0: 0 / P1: 0 / P2: 0 |
| 前端测试（FE） | 0 | P0: 0 / P1: 0 / P2: 0 |
| **合计** | **24** | P0: 8 / P1: 13 / P2: 3 |

其中 `[评审专项]` 用例：0 条

---

## 变更记录

| 版本 | 日期 | 作者 | 变更说明 |
|-----|------|-----|---------|
| v1.0.0 | 2026-06-17 | AI-Tester | 初始版本，首次生成 |
