# ai-handler 测试用例

---
文档编号：TC-20260617-001
版本：v1.0.0
状态：🟡 草稿
创建日期：2026-06-17
最后更新：2026-06-17
作者：AI-Tester
关联文档：
  - 详设文档：docs/design.md（§2.1 入口编排 + §3.5 Retry 策略）
---

## 1. 测试范围

- **被测模块**：AI 处理处理器（`src/ai-handler.ts`——核心 AI 处理循环、心跳、看门狗、重试、结果回复）
- **被测接口**：
  - `processAIMessage(ctx, sessionKey, message, msg)` — 主要入口，完整 AI 处理循环
  - `buildReplyMessage(summary, changedFiles, toolNames, fullLength, shareUrl, sessionId)` — 构建 Markdown 回复
  - `sendProcessingError(dingtalk, config, webhook, watchdogState, err, sessionId, isTimeout)` — 错误提示
- **用例总数**：27 条（单元测试 27）
- **关联业务规则**：BR-AIH-001~BR-AIH-020
- **关联代码评审报告**：无

---

## 2. 全局前置条件

1. Mock 外部依赖：`OpenCodeClient`、`DingTalkClient`、`SessionStore`、`Watchdog`
2. 使用 FakeTimers 控制 heartbeat setInterval
3. 所有测试不依赖真实钉钉/OpenCode 服务
4. `AIMessageContext` 的 `timeoutsPerSession` / `messagesPerSession` 为干净的 `Map`

---

## 3. 单元测试用例（UNIT）

### 3.1 processAIMessage——正常流程

| 用例 ID | 用例标题 | 优先级 | 关联规则 | 前置条件 | 测试步骤 | 预期结果 | 备注 |
|--------|---------|-------|---------|---------|---------|---------|-----|
| TC-AIH-UNIT-001 | 正常流程——session 已存在，复用现有 sessionId | P0 | BR-AIH-001 | Mock `sessions.get` 返回 `"existing-sid"`；`opencode.sendMessage` 正常返回 | 1. 调用 `processAIMessage` 2. 验证 | `sessions.get` 被调用；`opencode.sendMessage` 使用 `"existing-sid"`；`createSession` 未被调用 | |
| TC-AIH-UNIT-002 | 正常流程——session 不存在，创建新 session | P0 | BR-AIH-002 | Mock `sessions.get` 返回 undefined；`opencode.createSession` 返回 `{id: "new-sid"}` | 1. 调用 `processAIMessage` 2. 验证 | `opencode.createSession` 被调用（title 含 senderNick）；`sessions.set` 被调用；新 sessionId 用于 sendMessage | |
| TC-AIH-UNIT-003 | 正常流程——心跳每 60s 发送进度通知 | P1 | BR-AIH-003 | Mock `dingtalk.sendTextMessage`；使用 FakeTimers | 1. 调用 `processAIMessage` 2. 前进 60s 3. 前进 60s | `dingtalk.sendTextMessage` 被调用 2 次，内容含"任务仍在处理中"和等待时间 | |
| TC-AIH-UNIT-004 | 正常流程——成功后清除心跳 | P1 | BR-AIH-004 | Mock `opencode.sendMessage` 正常返回 | 1. 调用 `processAIMessage` 等待完成 2. 验证心跳已清除 | `clearInterval` 被调用，后续 tick 不再触发心跳消息 | |
| TC-AIH-UNIT-005 | 正常流程——成功后发送摘要回复 | P0 | BR-AIH-005 | Mock `opcode.extractSummary` 返回摘要+文件列表；`opencode.shareSession` 返回 null | 1. 调用 `processAIMessage` 等待完成 2. 验证 `dingtalk.sendMessage` 参数 | `dingtalk.sendMessage` 被调用，内容含 `buildReplyMessage` 的输出（摘要、文件列表、会话ID） | |
| TC-AIH-UNIT-006 | 正常流程——DingTalk 回复失败，发送失败通知 | P1 | BR-AIH-006 | Mock `dingtalk.sendMessage` 抛出异常；`opencode.sendMessage` 正常返回 | 1. 调用 `processAIMessage` 等待完成 2. 验证 | `dingtalk.sendMessage` 抛异常被 catch；`dingtalk.sendTextMessage` 发送"任务已完成但结果发送失败"通知；log.error 记录 | |

### 3.2 processAIMessage——重试逻辑

| 用例 ID | 用例标题 | 优先级 | 关联规则 | 前置条件 | 测试步骤 | 预期结果 | 备注 |
|--------|---------|-------|---------|---------|---------|---------|-----|
| TC-AIH-UNIT-007 | 网络错误重试第 1 次——创建新 session 重发 | P0 | BR-AIH-007 | Mock `opencode.sendMessage` 第 1 次抛出 `TypeError("fetch failed")`，第 2 次正常返回 | 1. 调用 `processAIMessage` 2. 验证 | 第 1 次失败→创建新 session（标题含时间戳）→第 2 次成功→发送摘要回复 | |
| TC-AIH-UNIT-008 | 网络错误重试耗尽——3 次后调用 sendProcessingError | P0 | BR-AIH-008 | Mock `opencode.sendMessage` 连续 3 次抛出 `TypeError("fetch failed")` | 1. 调用 `processAIMessage` 2. 验证 | 重试 3 次后，调用 `sendProcessingError` 含 `isTimeout=false`，错误原因为 "fetch failed" | |
| TC-AIH-UNIT-009 | 网络错误——重试间隔指数退避 | P1 | BR-AIH-009 | Mock `opencode.sendMessage` 连续 2 次失败 | 1. 调用 `processAIMessage` 2. 验证重试间隔 | 第 1 次后等待 1s，第 2 次后等待 2s（指数退避，最大 10s） | |
| TC-AIH-UNIT-010 | Watchdog restart 重试——检测到 restart 后创建新 session | P0 | BR-AIH-010 | Mock `opencode.sendMessage` 抛出 AbortError；Watchdog.state 返回 `"restart"` | 1. 调用 `processAIMessage` 2. 验证 | Watchdog stopped；新 session 创建；重发消息；最多 3 次 | |
| TC-AIH-UNIT-011 | Watchdog restart 重试耗尽——3 次后调用 sendProcessingError | P1 | BR-AIH-011 | Mock Watchdog.state 持续 `"restart"`，sendMessage 连续 3 次 AbortError | 1. 调用 `processAIMessage` 2. 验证 | 重试 3 次后调用 `sendProcessingError`，含 `watchdog.state="restart"` | |
| TC-AIH-UNIT-012 | 上下文撑爆——连续 2 次 AbortError 触发新 session 重试 | P0 | BR-AIH-012 | Mock `opencode.sendMessage` 前 2 次抛出 AbortError（timeout），第 3 次正常 | 1. 调用 `processAIMessage` 2. 验证 | 第 1 次 AbortError→`timeoutsPerSession`=1；第 2 次 AbortError→触发重试（新 session）；第 3 次成功 | |
| TC-AIH-UNIT-013 | 上下文撑爆 + 网络错误组合——timeoutsPerSession 在非超时错误时重置 | P2 | BR-AIH-013 | Mock: 第 1 次 AbortError→timeout=1；第 2 次普通 Error→timeout 归零 | 1. 调用 `processAIMessage` 2. 验证 | 第 2 次错误不触发重试（timeout=0），调用 sendProcessingError | |
| TC-AIH-UNIT-014 | Watchdog server_down——不重试，直接 sendProcessingError | P0 | BR-AIH-014 | Mock Watchdog.state 返回 `"server_down"` | 1. 调用 `processAIMessage` 2. 验证 | 不重试，调用 `sendProcessingError` 含 `watchdog.state="server_down"` | |
| TC-AIH-UNIT-015 | 普通 Error（非网络错误、非 AbortError）——不重试，直接 sendProcessingError | P1 | BR-AIH-015 | Mock `opencode.sendMessage` 抛出 `new Error("unknown")` | 1. 调用 `processAIMessage` 2. 验证 | 不重试，`sendProcessingError` 被调用，`isTimeout=false` | |

### 3.3 buildReplyMessage——纯函数

| 用例 ID | 用例标题 | 优先级 | 关联规则 | 前置条件 | 测试步骤 | 预期结果 | 备注 |
|--------|---------|-------|---------|---------|---------|---------|-----|
| TC-AIH-UNIT-016 | 有摘要无文件——结果含摘要，不含文件列表 | P1 | BR-AIH-016 | 传入 summary="摘要内容"，changedFiles=[]，toolNames=[]，fullLength=0，shareUrl=null，sessionId="sid-123" | 1. 调用 `buildReplyMessage(...)` | 结果字符串含"处理摘要"；不含"修改文件"；不含"使用操作"；不含"字符数"；含"会话ID" | |
| TC-AIH-UNIT-017 | 有文件无摘要——summary="(无文本回复)"，结果不含摘要 | P1 | BR-AIH-017 | 传入 summary="(无文本回复)"，changedFiles=["a.ts","b.ts"] | 1. 调用 `buildReplyMessage` | 结果不含"处理摘要"；含"修改文件"含 a.ts 和 b.ts | |
| TC-AIH-UNIT-018 | 有工具名——含"使用操作" | P2 | BR-AIH-018 | 传入 toolNames=["read","edit"] | 1. 调用 `buildReplyMessage` | 结果含"使用操作：`read`, `edit`" | |
| TC-AIH-UNIT-019 | fullLength > 0——含字符数 | P2 | BR-AIH-019 | 传入 fullLength=1234 | 1. 调用 `buildReplyMessage` | 结果含"回复总长度：1234 字符" | |
| TC-AIH-UNIT-020 | 有 shareUrl——含"查看完整对话"链接，不含"会话ID" | P1 | BR-AIH-020 | 传入 shareUrl="https://share.url" | 1. 调用 `buildReplyMessage` | 结果含"查看完整对话"链接 URL；不含"会话ID" | |
| TC-AIH-UNIT-021 | 无 shareUrl——含"会话ID"文本 | P1 | BR-AIH-021 | 传入 shareUrl=null，sessionId="sid-1234" | 1. 调用 `buildReplyMessage` | 结果含"会话ID: `sid-1234`" | |
| TC-AIH-UNIT-022 | 综合场景——所有字段都存在 | P2 | BR-AIH-022 | 传入 summary="sum"，changedFiles=["f.ts"]，toolNames=["tool1"]，fullLength=100，shareUrl="https://u"，sessionId="sid" | 1. 调用 `buildReplyMessage` | 结果同时含"处理摘要"、"修改文件"、"使用操作"、字符数、"查看完整对话" | |

### 3.4 sendProcessingError——按错误类型输出不同文本

| 用例 ID | 用例标题 | 优先级 | 关联规则 | 前置条件 | 测试步骤 | 预期结果 | 备注 |
|--------|---------|-------|---------|---------|---------|---------|-----|
| TC-AIH-UNIT-023 | watchdogState="server_down"——提示"服务不可用" | P0 | BR-AIH-023 | Mock `dingtalk.sendTextMessage` | 1. 调用 `sendProcessingError(dingtalk, config, webhook, "server_down", err, sid, false)` | `dingtalk.sendTextMessage` 被调用，内容含"服务不可用" | |
| TC-AIH-UNIT-024 | isTimeout=true——提示"任务超时" | P0 | BR-AIH-024 | Mock `dingtalk.sendTextMessage` | 1. 调用 `sendProcessingError(dingtalk, config, webhook, undefined, err, sid, true)` | `dingtalk.sendTextMessage` 被调用，内容含"任务超时"和超时秒数 | |
| TC-AIH-UNIT-025 | TypeError("fetch failed")——提示"网络连接失败" | P0 | BR-AIH-025 | Mock `dingtalk.sendTextMessage` | 1. 调用 `sendProcessingError(dingtalk, config, webhook, undefined, new TypeError("fetch failed"), sid, false)` | `dingtalk.sendTextMessage` 被调用，内容含"网络连接失败"和 opencodeServerUrl | |
| TC-AIH-UNIT-026 | 其他错误——提示"处理失败"+ 错误原因 | P1 | BR-AIH-026 | Mock `dingtalk.sendTextMessage` | 1. 调用 `sendProcessingError(dingtalk, config, webhook, undefined, new Error("unknown"), sid, false)` | `dingtalk.sendTextMessage` 被调用，内容含"处理失败"和"unknown" | |
| TC-AIH-UNIT-027 | sendProcessingError——dingtalk.sendTextMessage 本身失败不抛异常 | P1 | BR-AIH-027 | Mock `dingtalk.sendTextMessage` 抛出异常 | 1. 调用 `sendProcessingError(dingtalk, config, webhook, undefined, new Error("x"), sid, false)` | 异常被 `.catch(() => {})` 吞掉，不冒泡 | |

---

## 4. 集成测试用例（INTG）

本模块集成测试通过入口编排集成测试覆盖（见 TC-ENTRY-INTG-001：dispatch → processAIMessage）

---

## 5. 安全测试用例（SEC）

本模块无安全测试用例（模块为 AI 处理编排，不涉及认证/授权/注入）

---

## 6. 性能测试用例（PERF）

本模块无性能测试用例（重试间隔和心跳频率可配置，非独立性能瓶颈点）

---

## 7. 前端测试用例（FE）

本模块无前端测试用例（纯后端项目）

---

## 8. 用例统计

| 类型 | 数量 | 优先级分布 |
|-----|-----|---------|
| 单元测试（UNIT） | 27 | P0: 10 / P1: 13 / P2: 4 |
| 集成测试（INTG） | 0 | - |
| 安全测试（SEC） | 0 | - |
| 性能测试（PERF） | 0 | - |
| 前端测试（FE） | 0 | - |
| **合计** | **27** | P0: 10 / P1: 13 / P2: 4 |

其中 `[评审专项]` 用例：0 条

---

## 变更记录

| 版本 | 日期 | 作者 | 变更说明 |
|-----|------|-----|---------|
| v1.0.0 | 2026-06-17 | AI-Tester | 初始版本，根据重构后的 ai-handler.ts 生成 |
