# 消息调度与AI处理 测试用例

---
文档编号：TC-20260617-004
版本：v1.1.0
状态：🟡 草稿
创建日期：2026-06-17
最后更新：2026-06-18
作者：AI-Tester
关联文档：
  - 详设文档：doc/detailed/消息调度与AI处理.md
  - 项目规则：doc/detailed/项目规则.md
---

## 1. 测试范围

- **被测模块**：消息调度与AI处理（handleRobotMessage + processAIMessage + MessageQueue + Watchdog + dingtalk + buildReplyMessage + sendProcessingError + rateLimiter）
- **被测接口**：8 个（handleRobotMessage/processAIMessage/buildReplyMessage/sendProcessingError/MessageQueue.enqueue/Watchdog.start/stop/dingtalk.sendMessage/sendTextMessage/rateLimiter.tryConsume）
- **用例总数**：42 条（单元测试 30 + 集成测试 12 + 安全测试 0 + 性能测试 0）
- **关联业务规则**：MSG-REG-01 ~ MSG-REG-11
- **关联代码评审报告**：无
- **AC 追溯**：
  - AC-消息接收-01（@提及 文本消息处理）→ TC-MSG-UNIT-001
  - AC-消息接收-02（空消息引导提示）→ TC-MSG-UNIT-004, TC-MSG-INTG-002
  - AC-消息接收-03（非文本消息忽略）→ TC-MSG-UNIT-003, TC-MSG-INTG-003
  - AC-消息排队-01（同用户串行）→ TC-MSG-UNIT-005, TC-MSG-INTG-009
  - AC-消息排队-02（前序失败不影响后续）→ TC-MSG-UNIT-007
  - AC-AI处理-01（异常自动重试）→ TC-MSG-UNIT-009, TC-MSG-UNIT-010, TC-MSG-UNIT-011, TC-MSG-UNIT-012
  - AC-AI处理-02（服务不可用提示）→ TC-MSG-UNIT-014, TC-MSG-INTG-008
  - AC-AI处理-03（任务超时提示）→ TC-MSG-UNIT-012, TC-MSG-INTG-007

---

## 2. 全局前置条件

1. 所有外部依赖使用 Mock（opencode, dingtalk, sessionStore, serverManager, config）
2. 时钟使用 jest.useFakeTimers 控制定时器
3. AbortController/AbortSignal 使用 jest 模拟

---

## 3. 单元测试用例（UNIT）

### 业务规则覆盖用例

| 用例 ID | 用例标题 | 优先级 | 关联规则 | 前置条件 | 测试步骤 | 预期结果 | 备注 |
|--------|---------|-------|---------|---------|---------|---------|-----|
| TC-MSG-UNIT-001 | 仅处理 @提及 的文本消息 | P0 | MSG-REG-01 | 消息类型为 text，含 @提及 | 1. 调用 handleRobotMessage(text + @提及) | 进入后续处理流程 | |
| TC-MSG-UNIT-002 | 非 @提及 消息静默忽略 | P0 | MSG-REG-01 | 消息不含 @提及 | 1. 调用 handleRobotMessage(无 @提及) | 不处理，直接返回 | |
| TC-MSG-UNIT-003 | 非 text 类型消息忽略 | P0 | MSG-REG-01 | 消息类型为 image | 1. 调用 handleRobotMessage(image 消息) | 不处理，直接返回 | |
| TC-MSG-UNIT-004 | 空消息回复引导提示 | P0 | MSG-REG-02 | 仅 @提及 无文字 | 1. 调用 handleRobotMessage(仅 @提及) | dingtalk.sendTextMessage 被调用，内容为"你好 xxx，请描述您的需求" | |
| TC-MSG-UNIT-005 | 同 sessionKey 消息串行处理 | P0 | MSG-REG-03 | 同一用户连续 2 条消息 | 1. enqueue("key", fn1) 2. enqueue("key", fn2) | fn2 在 fn1 完成后执行 | |
| TC-MSG-UNIT-006 | 不同 sessionKey 消息并行处理 | P1 | MSG-REG-03 | 不同用户各 1 条消息 | 1. enqueue("key1", fn1) 2. enqueue("key2", fn2) | fn1 和 fn2 同时执行 | |
| TC-MSG-UNIT-007 | 前序任务失败不影响后续任务 | P1 | MSG-REG-03 | 第 1 个任务出错 | 1. enqueue("key", rejectFn) 2. enqueue("key", fn2) | fn2 仍然执行 | |
| TC-MSG-UNIT-008 | 心跳每 60s 发送进度通知 | P1 | MSG-REG-04 | processAIMessage 执行中 | 1. 启动 processAIMessage 2. 快进 60s | dingtalk.sendTextMessage 被调用，内容含"正在处理" | |
| TC-MSG-UNIT-009 | 重试条件：TypeError fetch failed | P1 | MSG-REG-05 | opencode.sendMessage 抛出 TypeError | 1. 执行 processAIMessage | 触发重试，retry_count 递增 | |
| TC-MSG-UNIT-010 | 重试条件：watchdog restart | P1 | MSG-REG-05 | watchdog 状态变为 restart | 1. 执行 processAIMessage 2. watchdog 触发 restart | 触发重试，创建新 session | |
| TC-MSG-UNIT-011 | 重试条件：连续 2 次 AbortError | P1 | MSG-REG-05 | 连续 2 次 AbortError | 1. 执行 processAIMessage 2. 连续 2 次 AbortError | 触发重试，删除旧 session | |
| TC-MSG-UNIT-012 | 最大重试 3 次 | P0 | MSG-REG-06 | 持续失败 | 1. 执行 processAIMessage 2. 连续失败 3 次 | 第 3 次后停止重试，发送错误提示 | |
| TC-MSG-UNIT-013 | 指数退避间隔 1s -> 2s -> 4s | P1 | MSG-REG-06 | 重试 3 次 | 1. 执行 processAIMessage 2. 检查重试间隔 | 第 1 次 1s，第 2 次 2s，第 3 次 4s | |
| TC-MSG-UNIT-014 | 看门狗连续 3 次 health 失败触发 server_down | P0 | MSG-REG-07 | 连续 3 次 health 返回 false | 1. watchdog.start() 2. 3 次 tick health 均失败 | state = "server_down"，不调用 abort（仅记录状态）| v1.1.0 变更：不再 abort |
| TC-MSG-UNIT-015 | 看门狗 session 消失触发 restart | P0 | MSG-REG-08 | sessionExists 返回 false | 1. watchdog.start() 2. tick 检测到 session 不存在 | state = "restart"，不调用 abort | v1.1.0 变更：不再 abort |
| TC-MSG-UNIT-027 | 看门狗使用 quickHealth 而非 health | P1 | MSG-REG-07 | 正常服务 | 1. watchdog.start() 2. 观察健康检查调用 | 调用 opencode.quickHealth()，5s 超时 | v1.1.0 新增 |
| TC-MSG-UNIT-028 | 看门狗不持有 AbortController | P1 | — | 正常构造 | 1. new Watchdog(sessionId) | 构造函数无 signal 参数，不传出 AbortController | v1.1.0 新增 |
| TC-MSG-UNIT-029 | sendMessage 内部超时不影响看门狗 | P1 | — | sendMessage 超时发出 AbortError | 1. sendMessage 超时 2. 检查 watchdog 状态 | watchdog 状态不受影响，仍为 running | v1.1.0 新增 |
| TC-MSG-UNIT-030 | session 失效（opencode 重启后旧 ID 无效）| P1 | — | sessionExists 返回 false | 1. processAIMessage 2. sessionExists=false | 删除旧 sessionId，创建新 session | v1.1.0 新增 |
| TC-MSG-UNIT-016 | 钉钉消息发送异常内部 catch | P1 | MSG-REG-09 | webhook 不可达 | 1. 调用 dingtalk.sendMessage | 日志 warn，不抛出异常 | |
| TC-MSG-UNIT-017 | 非法 JSON 消息日志警告不回复 | P1 | MSG-REG-10 | 损坏的原始数据 | 1. 调用 handleRobotMessage(非法 JSON) | 日志 warn，不回复 | |
| TC-MSG-UNIT-018 | 全局限流正常通过 | P1 | MSG-REG-11 | 每秒 30 个请求 | 1. 调用 rateLimiter.tryConsume() 30 次 | 全部返回 true | |
| TC-MSG-UNIT-019 | 全局限流超限返回 false | P1 | MSG-REG-11 | 每秒 60 个请求 | 1. 调用 rateLimiter.tryConsume() 60 次 | 超出部分返回 false，回复"系统繁忙" | |
| TC-MSG-UNIT-020 | 处理成功时心跳清除 + 结果回复 | P0 | — | 正常 AI 回复 | 1. 执行 processAIMessage 2. AI 回复成功 | 心跳清除，dingtalk.sendMessage 被调用 | |
| TC-MSG-UNIT-021 | TraceId 贯穿所有子调用 | P1 | — | 入口生成 requestId | 1. handleRobotMessage 2. 检查子调用 | processAIMessage/buildReplyMessage/sendProcessingError 均携带相同 requestId | 验证 REVIEW-DES-006 |
| TC-MSG-UNIT-022 | MessageQueue 链完成后延迟 1s 清理 | P1 | — | 链执行完成 | 1. enqueue("key", fn) 2. fn 完成 3. 等待 1s | queues 中对应 key 被 pop | 验证 REVIEW-DES-005 |
| TC-MSG-UNIT-023 | 错误枚举：TypeError 映射为 Network | P1 | — | TypeError 触发 | 1. processAIMessage 中 TypeError | last_error = ProcessingErrorType.Network | 验证 REVIEW-DES-007 |
| TC-MSG-UNIT-024 | 消息内容为超长文本（5000 字符） | P2 | 消息长度上限 | Mock fetch 正常 | 1. 调用 handleRobotMessage(5000 字符 + @提及) | 正常处理，进入后续流程 | 边界值补充 |
| TC-MSG-UNIT-025 | 消息内容为单个字符 | P2 | 消息长度下限 | Mock fetch 正常 | 1. 调用 handleRobotMessage("a" + @提及) | 正常处理，进入后续流程 | 边界值补充 |
| TC-MSG-UNIT-026 | 限流边界值：每秒 30 个请求（恰好通过） | P2 | 限流阈值边界 | 每秒 30 个请求 | 1. 调用 rateLimiter.tryConsume() 30 次 | 全部返回 true | 边界值补充 |

---

## 4. 集成测试用例（INTG）

### 消息入口完整流程

| 用例 ID | 用例标题 | 优先级 | 前置条件 | 请求参数 | 预期状态码 | 预期响应体关键字段 | 备注 |
|--------|---------|-------|---------|---------|----------|----------------|-----|
| TC-MSG-INTG-001 | 正常消息全链路处理 | P0 | 所有 Mock 正常 | 合法文本消息 + @提及 | — | 已收到 -> 处理中 -> 结果回复到钉钉 | |
| TC-MSG-INTG-002 | 空消息触发引导提示 | P0 | — | 仅 @提及 无文字 | — | 回复"你好 xxx，请描述您的需求" | |
| TC-MSG-INTG-003 | 非 text 消息被忽略 | P1 | — | 图片消息 | — | 不回复，无日志异常 | |
| TC-MSG-INTG-004 | 项目指令路由 | P1 | 消息为"项目列表" | "项目列表"文本 | — | 路由到 project-registry/server-manager | |

### AI 处理循环完整流程

| 用例 ID | 用例标题 | 优先级 | 前置条件 | 请求参数 | 预期状态码 | 预期响应体关键字段 | 备注 |
|--------|---------|-------|---------|---------|----------|----------------|-----|
| TC-MSG-INTG-005 | session 首次创建 | P0 | 无已有 session | processAIMessage | — | createSession 被调用，sessionStore.set 被调用 | |
| TC-MSG-INTG-006 | session 已存在复用 | P1 | sessionStore 已有 sessionId | processAIMessage | — | 复用 sessionId，不调用 createSession | |
| TC-MSG-INTG-007 | 重试耗尽发送错误提示 | P1 | 连续 3 次失败 | processAIMessage | — | sendProcessingError 被调用，提示"服务不可用"或"任务超时" | |
| TC-MSG-INTG-008 | 看门狗 server_down 中止处理 | P1 | 连续 3 次 health 失败 | processAIMessage | — | AbortError 抛出，提示"服务不可用" | |

### 消息排队完整流程

| 用例 ID | 用例标题 | 优先级 | 前置条件 | 请求参数 | 预期状态码 | 预期响应体关键字段 | 备注 |
|--------|---------|-------|---------|---------|----------|----------------|-----|
| TC-MSG-INTG-009 | 同用户串行 -> 不同用户并行 | P0 | 2 个用户各发 2 条 | enqueue 4 次 | — | 同用户串行执行，不同用户并行执行 | |
| TC-MSG-INTG-010 | 限流超限回复繁忙 | P1 | 每秒超过 50 个请求 | handleRobotMessage 并发 60 次 | — | 超出部分回复"系统繁忙，请稍后再试" | |
| TC-MSG-INTG-011 | session 失效后自动重建 | P1 | sessionExists 返回 false | processAIMessage → session 验证失败 | — | 删除旧 sessionId，重新创建新 session，继续处理 | v1.1.0 新增 |
| TC-MSG-INTG-012 | 看门狗 server_down 不中断消息 | P1 | 连续 3 次 health 失败 | processAIMessage 执行中 watchdog 触发 server_down | — | 消息继续处理（不产生 AbortError），完成后如超时则走超时逻辑 | v1.1.0 新增 |

---

## 5. 安全测试用例（SEC）

本模块无安全测试用例（鉴权由 @提及 过滤保证；消息文本仅作为文本传递给 OpenCode API，不拼接执行；异常内部隔离不传播）。

---

## 6. 性能测试用例（PERF）

本模块无性能测试用例（消息接收确认 P95 <= 2s，enqueue <= 10ms，看门狗每 60s 执行，性能风险低）。

---

## 7. 前端测试用例（FE）

本模块为后端模块，无前端测试用例。

---

## 8. 用例统计

| 类型 | 数量 | 优先级分布 |
|-----|-----|---------|
| 单元测试（UNIT） | 30 | P0: 8 / P1: 18 / P2: 4 |
| 集成测试（INTG） | 12 | P0: 5 / P1: 7 / P2: 0 |
| 安全测试（SEC） | 0 | P0: 0 / P1: 0 / P2: 0 |
| 性能测试（PERF） | 0 | P0: 0 / P1: 0 / P2: 0 |
| 前端测试（FE） | 0 | P0: 0 / P1: 0 / P2: 0 |
| **合计** | **42** | P0: 13 / P1: 25 / P2: 4 |

其中 `[评审专项]` 用例：3 条（REVIEW-DES-005, REVIEW-DES-006, REVIEW-DES-007）

---

## 变更记录

| 版本 | 日期 | 作者 | 变更说明 |
|-----|------|-----|---------|
| v1.0.0 | 2026-06-17 | AI-Tester | 初始版本，首次生成 |
| v1.1.0 | 2026-06-18 | AI-Tester | 更新 watchdog 测试：不再 abort、新增 quickHealth 测试、session 失效验证；新增集成测试 TC-MSG-INTG-011/012 |
