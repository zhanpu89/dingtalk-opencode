# dingtalk-opencode 设计文档

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                     DingTalk Server                       │
│  (WebSocket Stream Mode)                                 │
└──────────────┬──────────────────────────────────────────┘
               │ 回调消息 (robot message callback)
               ▼
┌─────────────────────────────────────────────────────────┐
│                  index.ts (入口 + 编排)                    │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │
│  │ Message  │→ │ Watchdog │→ │  Retry Loop          │  │
│  │ Queue    │  │ (看门狗)  │  │  (do-while)          │  │
│  └──────────┘  └──────────┘  └──────┬───────────────┘  │
│                                     │                   │
└─────────────────────────────────────┼───────────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                  ▼
           ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
           │  opencode.ts │  │  dingtalk.ts │  │ session-     │
           │  (API客户端)  │  │  (消息发送)   │  │ store.ts     │
           └──────────────┘  └──────────────┘  └──────────────┘
```

## 2. 组件设计

### 2.1 入口编排 (`src/index.ts`)

**职责**：
- 连接钉钉 Stream（WebSocket），注册消息回调
- 消息解析、鉴权（@提及过滤）
- 编排整个处理流程：session 获取 → watchdog 启动 → 流式请求 → 结果回复 → 错误处理

**核心流程**：

```
handleRobotMessage(raw)
  ├─ JSON.parse → RobotTextMessage
  ├─ stripBotMention → 提取纯文本
  ├─ dingtalk.sendTextMessage("已收到消息...")
  └─ queue.enqueue(sessionKey, async () => {
       ├─ heartbeat setInterval(60s) → 用户进度通知
       ├─ do {
       │   ├─ sessions.get → sessionId (or createSession)
       │   ├─ new Watchdog(...).start()
       │   ├─ opencode.sendMessage(sessionId, msg, signal)
       │   ├─ watchdog.stop()
       │   ├─ clearInterval(heartbeat)
       │   ├─ buildReplyMessage() → dingtalkReply
       │   └─ dingtalk.sendMessage(webhook, reply)
       │ } while (shouldRetry)
     })
```

**测试要点**：

| 场景 | 验证点 |
|------|--------|
| 正常消息处理 | 收到 -> 发送处理中 -> 发送结果回复 |
| 空消息（仅 @提及） | 回复"你好 xxx"引导提示 |
| 非 text 类型消息 | 忽略，不回复 |
| 非法 JSON | 日志警告，不回复 |
| 消息排队 | 同一 sessionKey 的消息串行执行 |
| session 首次创建 | createSession 被调用 |
| session 已存在 | 复用现有 sessionId |
| 处理成功 | heartbeat 清除，结果回复到钉钉 |
| DingTalk 回复失败 | 日志记录，用户收到"任务已完成但结果发送失败" |
| 看门狗 restart 触发 | 创建新 session，重新发送消息（最多 1 次） |
| 看门狗 server_down 触发 | 提示"OpenCode 服务不可用" |
| 超时 (AbortError) | 提示"任务超时" |
| 其他错误 | 提示"处理失败"+ 错误原因 |

### 2.2 OpenCode API 客户端 (`src/opencode.ts`)

**职责**：
- 封装 opencode HTTP API 调用
- 流式消息发送（Phase 1: 连接 + Phase 2: 流读取）
- session 管理（创建、查询、分享）

**状态图**（`sendMessage`）：

```
                Phase 1                     Phase 2
sendMessage ─────────► fetch POST ─────────► reader.read() 循环 ────► JSON.parse ──► return
                         │                      │
                    连接超时                  watchdog abort
                   (timeoutMs)           (AbortSignal 外部信号)
                         │                      │
                         ▼                      ▼
                    AbortError ─────────► catch ──► throw AbortError
```

**测试要点**：

| 场景 | 验证点 |
|------|--------|
| 正常流式响应 | 所有 chunk 拼接后正确 JSON.parse |
| 分块到达 | 多个 chunk 正确拼接，不乱码 |
| Phase 1 超时 | AbortError 传播，不遗漏 timer 清理 |
| 外部 AbortSignal 触发 | 流读取中断，AbortError 传播 |
| 外部 signal 在调用前已 abort | fetch 立即拒绝 |
| HTTP 非 200 响应 | throw Error(status + body) |
| sessionExists — session 存在 | 返回 true |
| sessionExists — session 不存在 | 返回 false |
| sessionExists — API 错误 | 返回 null |
| createSession — 新 session | POST /session 被调用 |
| createSession — 已有同名 | GET /session 找到并复用 |
| shareSession — 成功 | 返回 shareURL |
| shareSession — 失败 | 返回 null，日志 warn |
| health — 服务正常 | 返回 true |
| health — 服务异常 | 返回 false |

### 2.3 看门狗 (`src/watchdog.ts`)

**职责**：
- 与流读取并行运行，周期性检查 OpenCode 服务健康状态和 session 存活
- 发现问题时通过 AbortController 中止流读取

**状态机**：

```
                    ┌─────────┐
                    │ running │
                    └────┬────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
              ▼          ▼          ▼
         server_down  restart    running
         (健康检查     (session   (一切正常,
          连续3次失败)   消失)     继续等待)
```

**定时器逻辑**（单 `setInterval`，默认 60s）：

```
每个 tick:
  1. checkHealth()
     └─ opencode.health()
         ├─ healthy → 重置连续失败计数
         └─ 不健康 → 连续失败++
             └─ ≥3 → state = "server_down", abortController.abort()
  2. checkSession()
     └─ opencode.sessionExists(sessionId)
         ├─ false → state = "restart", abortController.abort()
         ├─ true  → 跳过
         └─ null  → API 错误，跳过（不误判 restart）
```

**测试要点**：

| 场景 | 验证点 |
|------|--------|
| 健康检查正常 | consecutiveHealthFailures = 0，state = running |
| 健康检查连续失败 < 3 | consecutiveHealthFailures 递增，state 不变 |
| 健康检查连续失败 = 3 | state = server_down，abortController 被调用 |
| 健康检查异常（throw） | 计入连续失败计数 |
| session 存在 | state 不变 |
| session 消失 | state = restart，abortController 被调用 |
| sessionExists 返回 null | 跳过本轮，state 不变 |
| checkSession 抛异常 | 被 catch 吞掉，state 不变 |
| start() 调用 | 定时器启动 |
| stop() 调用 | 定时器清除 |
| start → stop → start | 旧定时器清除，新定时器启动 |
| 多次 stop 安全 | 不会 crash |

### 2.4 钉钉消息发送 (`src/dingtalk.ts`)

**职责**：
- 封装钉钉 Webhook 消息发送
- Markdown 和纯文本两种消息类型

**设计要点**：
- 所有 fetch 调用由 `send()` 私有方法统一处理
- 网络异常被 `catch` 吞掉并日志 warn，不向上传播（调用方不需要处理发送失败）
- 不抛出异常——确保错误消息场景下不会因为发送失败而连锁崩溃

**测试要点**：

| 场景 | 验证点 |
|------|--------|
| sendMessage 正常 | fetch POST 调用，返回 void |
| sendTextMessage 正常 | fetch POST 调用 msgtype=text |
| 网络异常 (fetch throw) | catch 日志 warn，不抛异常 |
| HTTP 非 200 | 日志 warn status + body |
| long content | 超长文本正常发送（取决于钉钉限制） |

### 2.5 Session 存储 (`src/session-store.ts`)

**职责**：
- 钉钉会话 ↔ OpenCode session ID 的持久化映射
- 写入时延迟 2s flush 防抖

**测试要点**：

| 场景 | 验证点 |
|------|--------|
| 首次启动（文件不存在） | 创建空文件，初始 size = 0 |
| set + flush | JSON 文件正确写入 |
| 程序启动加载 | 文件内容正确恢复为 Map |
| 多次 set 不频繁写盘 | 2s 内仅 flush 一次 |
| 文件损坏 | 日志错误，空 Map 启动 |
| get 不存在 key | 返回 undefined |
| size | 返回正确条目数 |

### 2.6 消息队列 (`src/message-queue.ts`)

**职责**：
- 按 sessionKey 串行化消息处理（同一个用户的多个请求排队）
- 前一个任务失败不影响后续任务

**设计要点**：
- 使用 Promise 链实现串行：`prev.then(fn, fn)` — 无论前一个成功/失败都执行 `fn`
- `next.catch(() => {})` 吞掉整条链的最终 rejection（错误已由 handler 内部处理）

**测试要点**：

| 场景 | 验证点 |
|------|--------|
| 依次入队 2 个 | 第 2 个在第 1 个完成后执行 |
| 第 1 个失败 | 第 2 个仍执行 |
| 并发入队不同 key | 并行执行 |

## 3. 关键设计决策

### 3.1 为什么移除逐块空闲超时？

**问题**：流式 API 有逐块空闲超时（per-chunk idle timeout），AI 长思考时不产生数据块会导致超时误判。

**决策**：移除逐块空闲超时，改为看门狗并行检测：
- AI 真实思考 → 看门狗健康检查正常，流等待
- 服务宕机 → 看门狗 3 次检查失败后中止
- session 消失 → 看门狗检测后中止 + 自动重试

### 3.2 为什么用 AbortController 而不是自定义事件？

AbortController 是 Web 原生 API，与 fetch 的 signal 机制原生集成：
- 看门狗调用 `abortController.abort()` → fetch 流读取立即抛出 AbortError
- 不需要额外的轮询或状态检查
- 与现有 fetch 超时机制复用同一路径

### 3.3 为什么 session 存在检查用 `boolean | null` 而非 `boolean`？

`GET /session` 可能因网络抖动返回非正常响应。如果直接返回 `boolean`，无法区分"session 不存在"和"API 出错"。
- `false` = 确认不存在（触发 restart）
- `null` = API 出错（跳过本轮检查，避免误 restart）

### 3.4 为什么消息发送不抛异常？

所有 `dingtalk.sendMessage/sendTextMessage` 的异常都在内部 catch 并日志 warn。原因：
- 发送回复失败不应影响已完成的 AI 处理结果
- 错误消息发送失败不应连锁导致更严重的问题
- 调用方通过 `.catch(() => {})` 确保不产生 unhandled rejection

### 3.5 为什么 retry 最多 1 次？

session 消失后创建新 session 重试：
- 如果重试成功 → 用户无感知
- 如果重试再次失败 → 大概率是持续性问题（服务宕机、网络中断），重试无意义
- 限制 1 次避免无限循环

## 4. 集成测试场景

### 4.1 端到端流程

```
启动流程:
  1. 环境变量加载 → 配置正确
  2. DWClient.connect() → WebSocket 连接建立
  3. TOPIC_ROBOT 注册 → 回调就绪

消息处理流程:
  1. 发送文本 "@OpenCode 修复登录bug" to 钉钉
  2. 钉钉 Stream 回调 → handleRobotMessage
  3. 检查: "⏳ 已收到消息..." 回复
  4. 检查: opencode session 创建/复用
  5. 检查: opencode.sendMessage 被调用（流式）
  6. 等待处理完成
  7. 检查: "✅ 任务完成" + 摘要 + 文件列表 + 会话链接
```

### 4.2 异常场景

| 场景 | 预期行为 |
|------|---------|
| opencode 服务不可用 | 看门狗 3 次检查后 → ❌ OpenCode 服务不可用 |
| 处理中途 session 消失 | 看门狗检测 → 创建新 session 重试 |
| 钉钉 Webhook 过期 | 日志 warn，回复发送失败消息 |
| 网络断连后恢复 | 看门狗检测到恢复，继续等待 |
| 消息队列中前一个任务卡死 | 不影响后续任务（心跳仍运行） |
| SIGTERM/SIGINT | ? 清理 session-store，断开 WebSocket，正常退出 |
