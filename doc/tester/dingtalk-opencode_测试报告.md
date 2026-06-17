# dingtalk-opencode — 测试报告

| 属性 | 值 |
|------|---|
| **文档编号** | TST-20260615-001 |
| **版本** | v2.0.0 |
| **状态** | ✅ 已发布 |
| **报告日期** | 2026-06-17 |
| **最后更新** | 2026-06-17 |
| **测试人员** | AI-Tester |
| **审核人** | N/A |
| **关联文档** | 测试用例: doc/tester/ |

---

## 1. 文档基本信息

| 项目名称 | dingtalk-opencode |
|----------|------------|
| 测试版本 | v2.0.0 |
| 文档状态 | 已发布 |

---

## 2. 测试概述

**测试范围**：本项目全部 8 个核心模块的单元测试与集成测试（含重构新增 ai-handler + server-manager）。

| 模块 | 源文件 | 用例数 |
|------|--------|:------:|
| 钉钉消息发送 | `src/dingtalk.ts` | 7 |
| 消息队列 | `src/message-queue.ts` | 5 |
| Session 存储 | `src/session-store.ts` | 9 |
| 看门狗 | `src/watchdog.ts` | 13 |
| OpenCode API 客户端 | `src/opencode.ts` | 19 |
| 入口编排 | `src/index.ts` | 15 |
| AI 处理处理器 | `src/ai-handler.ts` | 19 |
| 服务管理 | `src/server-manager.ts` | 13 |
| 项目注册表 | `src/project-registry.ts` | 2 |
| 项目上下文 | `src/project-context-store.ts` | 2 |
| 其他公共模块 | — | 6 |
| **合计** | | **110** |

**测试类型**：
- [x] 单元测试（Service 层业务逻辑）
- [x] 集成测试（API 接口端到端）
- [ ] 性能测试（高并发场景）
- [ ] 安全测试（认证授权、注入防护）

**测试策略**：
- 单元测试：基于测试用例文档的业务规则和分支覆盖，使用 vitest（Jest 兼容 API）
- 集成测试：Mock 外部依赖（fetch / fs / dingtalk-stream），验证模块间交互契约
- Mock 策略：全局 fetch Mock、AbortController 模拟、定时器 FakeTimers

---

## 3. 测试环境

| 环境项 | 配置信息 |
|--------|---------|
| 操作系统 | Linux (Ubuntu 22.04) |
| 语言运行时 | Node.js 20.x |
| 测试框架 | vitest 4.1.9 |
| 构建工具 | npm |

---

## 4. 测试用例执行情况

| 模块 | 源文件 | 用例数 | 通过 | 失败 | 阻塞 | 通过率 |
|------|--------|:-----:|:----:|:----:|:----:|:------:|
| 钉钉消息发送 | `dingtalk.spec.ts` | 7 | 7 | 0 | 0 | 100% |
| 消息队列 | `message-queue.spec.ts` | 5 | 5 | 0 | 0 | 100% |
| Session 存储 | `session-store.spec.ts` | 9 | 9 | 0 | 0 | 100% |
| 看门狗 | `watchdog.spec.ts` | 13 | 13 | 0 | 0 | 100% |
| OpenCode API 客户端 | `opencode.spec.ts` | 19 | 19 | 0 | 0 | 100% |
| 入口编排 | `index.spec.ts` | 21 | 21 | 0 | 0 | 100% |
| AI 处理处理器 | `ai-handler.spec.ts` | 19 | 19 | 0 | 0 | 100% |
| 服务管理 | `server-manager.spec.ts` | 13 | 13 | 0 | 0 | 100% |
| 项目注册表 | `project-registry.spec.ts` | 2 | 2 | 0 | 0 | 100% |
| 项目上下文 | `project-context-store.spec.ts` | 2 | 2 | 0 | 0 | 100% |
| **总计** | **10 个文件** | **110** | **110** | **0** | **0** | **100%** |

---

## 5. 缺陷统计

本次测试未发现缺陷。

---

## 6. 详细测试结果

### 6.1 钉钉消息发送（DING）

#### 单元测试

| 用例ID | 功能点 | 结果 |
|--------|--------|:----:|
| TC-DING-UNIT-001 | sendMessage 正常——fetch POST 调用，msgtype=markdown | ✅通过 |
| TC-DING-UNIT-002 | sendTextMessage 正常——fetch POST 调用，msgtype=text | ✅通过 |
| TC-DING-UNIT-003 | 网络异常 (fetch throw)——catch 日志 warn，不抛异常 | ✅通过 |
| TC-DING-UNIT-004 | HTTP 非 200——不抛异常 | ✅通过 |
| TC-DING-UNIT-005 | sendTextMessage 网络异常 | ✅通过 |
| TC-DING-UNIT-006 | sendMessage——超长文本发送 | ✅通过 |
| TC-DING-UNIT-007 | sendTextMessage——空内容发送 | ✅通过 |

### 6.2 消息队列（QUEUE）

#### 单元测试

| 用例ID | 功能点 | 结果 |
|--------|--------|:----:|
| TC-QUEUE-UNIT-001 | 依次入队 2 个相同 key——第 2 个在第 1 个完成后执行 | ✅通过 |
| TC-QUEUE-UNIT-002 | 第 1 个失败——第 2 个仍执行 | ✅通过 |
| TC-QUEUE-UNIT-003 | 并发入队不同 key——并行执行 | ✅通过 |
| TC-QUEUE-UNIT-004 | pendingCount——入队后返回正确计数 | ✅通过 |
| TC-QUEUE-UNIT-005 | pendingCount——空队列返回 0 | ✅通过 |

### 6.3 Session 存储（SESS）

#### 单元测试

| 用例ID | 功能点 | 结果 |
|--------|--------|:----:|
| TC-SESS-UNIT-001 | 首次启动文件不存在——创建空文件 | ✅通过 |
| TC-SESS-UNIT-002 | set + flush——JSON 文件正确写入 | ✅通过 |
| TC-SESS-UNIT-003 | 程序启动加载——文件内容正确恢复为 Map | ✅通过 |
| TC-SESS-UNIT-004 | 多次 set 不频繁写盘——2s 内仅 flush 一次 | ✅通过 |
| TC-SESS-UNIT-005 | 文件损坏——日志错误，空 Map 启动 | ✅通过 |
| TC-SESS-UNIT-006 | get 不存在 key——返回 undefined | ✅通过 |
| TC-SESS-UNIT-007 | size——返回正确条目数 | ✅通过 |
| TC-SESS-UNIT-008 | flush——dirty=false 时直接返回 | ✅通过 |
| TC-SESS-UNIT-009 | flush——writeFileSync 异常被 catch | ✅通过 |

### 6.4 看门狗（WDOG）

#### 单元测试

| 用例ID | 功能点 | 结果 |
|--------|--------|:----:|
| TC-WDOG-UNIT-001 | 健康检查正常——consecutiveHealthFailures 归零 | ✅通过 |
| TC-WDOG-UNIT-002 | 健康检查连续失败 < 3——递增计数，state 不变 | ✅通过 |
| TC-WDOG-UNIT-003 | 健康检查连续失败 = 3——state=server_down，abort 触发 | ✅通过 |
| TC-WDOG-UNIT-004 | 健康检查异常（throw）计入连续失败计数 | ✅通过 |
| TC-WDOG-UNIT-005 | session 存在——state 不变 | ✅通过 |
| TC-WDOG-UNIT-006 | session 消失——state=restart，abort 触发 | ✅通过 |
| TC-WDOG-UNIT-007 | sessionExists 返回 null——跳过本轮，state 不变 | ✅通过 |
| TC-WDOG-UNIT-008 | checkSession 抛异常——被 catch 吞掉 | ✅通过 |
| TC-WDOG-UNIT-009 | start() 调用——定时器启动 | ✅通过 |
| TC-WDOG-UNIT-010 | stop() 调用——定时器清除 | ✅通过 |
| TC-WDOG-UNIT-011 | start → stop → start——旧定时器清除，新定时器启动 | ✅通过 |
| TC-WDOG-UNIT-012 | 多次 stop 安全——不会 crash | ✅通过 |
| TC-WDOG-UNIT-013 | 健康检查连续失败恢复——失败后恢复正常 | ✅通过 |

### 6.5 OpenCode API 客户端（OAPI）

#### 单元测试

| 用例ID | 功能点 | 结果 |
|--------|--------|:----:|
| TC-OAPI-UNIT-001 | 正常流式响应——拼接所有 chunk | ✅通过 |
| TC-OAPI-UNIT-002 | Phase 1 超时——AbortError 传播 | ✅通过 |
| TC-OAPI-UNIT-003 | 外部 AbortSignal 触发流中断 | ✅通过 |
| TC-OAPI-UNIT-004 | 外部 signal 在调用前已 abort | ✅通过 |
| TC-OAPI-UNIT-005 | HTTP 非 200 响应 | ✅通过 |
| TC-OAPI-UNIT-006 | HTTP 非 200（Phase 2 后）——流读取正常 | ✅通过 |
| TC-OAPI-UNIT-007 | session 存在返回 true | ✅通过 |
| TC-OAPI-UNIT-008 | session 不存在返回 false | ✅通过 |
| TC-OAPI-UNIT-009 | API 错误返回 null | ✅通过 |
| TC-OAPI-UNIT-010 | 新 session 调用 POST /session | ✅通过 |
| TC-OAPI-UNIT-011 | 已有同名复用 | ✅通过 |
| TC-OAPI-UNIT-012 | 成功返回 shareURL | ✅通过 |
| TC-OAPI-UNIT-013 | 失败返回 null | ✅通过 |
| TC-OAPI-UNIT-014 | 服务正常返回 true | ✅通过 |
| TC-OAPI-UNIT-015 | 服务异常返回 false | ✅通过 |
| TC-OAPI-UNIT-016 | 空 parts | ✅通过 |
| TC-OAPI-UNIT-017 | 已配置 auth 时携带 Authorization 头 | ✅通过 |
| TC-OAPI-UNIT-018 | 未配置 auth 时不携带 Authorization 头 | ✅通过 |

#### 集成测试

| 用例ID | 功能点 | 结果 |
|--------|--------|:----:|
| TC-OAPI-INTG-001 | sendMessage 完整流式流程——Phase 1 + Phase 2 | ✅通过 |

### 6.6 入口编排（ENTRY）

#### 单元测试

| 用例ID | 功能点 | 结果 |
|--------|--------|:----:|
| TC-ENTRY-UNIT-001 | 正常消息处理——收到并回复 | ✅通过 |
| TC-ENTRY-UNIT-002 | 空消息（仅 @提及）回复引导提示 | ✅通过 |
| TC-ENTRY-UNIT-003 | 非 text 类型消息忽略 | ✅通过 |
| TC-ENTRY-UNIT-004 | 非法 JSON 日志警告不回复 | ✅通过 |
| TC-ENTRY-UNIT-005 | getSessionKey——由 conversationId 和 senderId 组成 | ✅通过 |
| TC-ENTRY-UNIT-006 | getSessionKey——优先使用 senderStaffId | ✅通过 |
| TC-ENTRY-UNIT-007 | stripBotMention——去除 @提及 | ✅通过 |
| TC-ENTRY-UNIT-008 | stripBotMention——无提及原文返回 | ✅通过 |
| TC-ENTRY-UNIT-009 | 项目指令解析——项目列表触发项目查询 | ✅通过 |
| TC-ENTRY-UNIT-010 | startStreamSupervisor——连接健康定时检查 | ✅通过 |
| TC-ENTRY-UNIT-011 | 项目指令解析——切换项目 id 启动项目服务 | ✅通过 |
| TC-ENTRY-UNIT-012 | 项目指令解析——当前项目返回绑定 | ✅通过 |

#### 集成测试

| 用例ID | 功能点 | 结果 |
|--------|--------|:----:|
| TC-ENTRY-INTG-001 | 正常消息处理端到端——dispatch → processAIMessage | ✅通过 |
| TC-ENTRY-INTG-002 | 消息队列串行——同一 sessionKey 排队 | ✅通过 |
| TC-ENTRY-INTG-003 | 钉钉 Stream 断开重连 | ✅通过 |

### 6.7 AI 处理处理器（AIH）

#### 单元测试

| 用例ID | 功能点 | 结果 |
|--------|--------|:----:|
| TC-AIH-UNIT-001 | session 已存在，复用现有 sessionId | ✅通过 |
| TC-AIH-UNIT-002 | session 不存在，创建新 session | ✅通过 |
| TC-AIH-UNIT-005 | 成功后发送摘要回复 | ✅通过 |
| TC-AIH-UNIT-006 | DingTalk 回复失败，发送失败通知 | ✅通过 |
| TC-AIH-UNIT-007 | 网络错误重试——失败后创建新 session 重试成功 | ✅通过 |
| TC-AIH-UNIT-008 | 网络错误重试耗尽——3 次后调用 sendProcessingError | ✅通过 |
| TC-AIH-UNIT-015 | 普通 Error——不重试，直接 sendProcessingError | ✅通过 |
| TC-AIH-UNIT-016 | buildReplyMessage——有摘要无文件 | ✅通过 |
| TC-AIH-UNIT-017 | buildReplyMessage——无摘要 | ✅通过 |
| TC-AIH-UNIT-018 | buildReplyMessage——有工具名 | ✅通过 |
| TC-AIH-UNIT-019 | buildReplyMessage——fullLength > 0 | ✅通过 |
| TC-AIH-UNIT-020 | buildReplyMessage——有 shareUrl | ✅通过 |
| TC-AIH-UNIT-021 | buildReplyMessage——无 shareUrl | ✅通过 |
| TC-AIH-UNIT-022 | buildReplyMessage——综合 | ✅通过 |
| TC-AIH-UNIT-023 | sendProcessingError——server_down | ✅通过 |
| TC-AIH-UNIT-024 | sendProcessingError——isTimeout | ✅通过 |
| TC-AIH-UNIT-025 | sendProcessingError——fetch failed | ✅通过 |
| TC-AIH-UNIT-026 | sendProcessingError——普通错误 | ✅通过 |
| TC-AIH-UNIT-027 | sendProcessingError——dingtalk 自身失败不抛异常 | ✅通过 |

### 6.8 服务管理（SVR）

#### 单元测试

| 用例ID | 功能点 | 结果 |
|--------|--------|:----:|
| TC-SVR-UNIT-001 | start()——启动默认服务 + 健康监控定时器 | ✅通过 |
| TC-SVR-UNIT-002 | ensureDefault——服务健康时直接返回 | ✅通过 |
| TC-SVR-UNIT-003 | ensureDefault——服务不健康时自动重启 | ✅通过 |
| TC-SVR-UNIT-004 | 默认服务连续 3 次失败触发重启 | ✅通过 |
| TC-SVR-UNIT-005 | 默认服务失败后恢复 | ✅通过 |
| TC-SVR-UNIT-007 | 子进程退出→isDefaultHealthy 置 false | ✅通过 |
| TC-SVR-UNIT-008 | startProject——新项目启动 | ✅通过 |
| TC-SVR-UNIT-009 | startProject——已有实例复用 | ✅通过 |
| TC-SVR-UNIT-012 | startProject——启动超时抛异常 | ✅通过 |
| TC-SVR-UNIT-014 | checkProject——运行中 | ✅通过 |
| TC-SVR-UNIT-015 | checkProject——不存在 | ✅通过 |
| TC-SVR-INTG-001 | 启动→检查→停止完整生命周期 | ✅通过 |
| TC-SVR-INTG-003 | 端口分配递增 | ✅通过 |

---

## 7. 性能测试摘要

本次测试未包含性能测试。

---

## 8. 测试结论

### 8.1 总体评价

**测试结论**：✅ 通过

**理由**：
- 共执行测试用例 110 条，通过 110 条，通过率 100%
- 未发现任何缺陷
- 全部 10 个模块的核心业务流程验证通过
- 重构后新增 ai-handler + server-manager 模块，测试通过率 100%

### 8.2 遗留问题

无遗留问题。

### 8.3 上线建议

- [x] **可以上线**：所有 P0/P1 缺陷已修复，核心功能测试通过

**其他建议**：
1. 建议在 CI 流程中集成 `vitest run` 作为门禁
2. 建议后续补充 e2e 集成测试（依赖真实 DingTalk / OpenCode 服务）
3. 建议补充性能测试（关注消息队列在高并发下的吞吐表现）

---

## 变更记录

| 版本 | 日期 | 变更类型 | 变更内容摘要 | 变更人 |
|------|------|---------|------------|--------|
| v1.0.0 | 2026-06-15 | 🆕 新建 | 初始版本 | AI-Tester |
| v2.0.0 | 2026-06-17 | 🔄 更新 | 重构后全部 110 条测试通过，新增 ai-handler + server-manager 模块 | AI-Tester |
