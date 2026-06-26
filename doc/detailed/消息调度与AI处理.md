# dingtalk-opencode — 消息调度与AI处理 详细设计文档

**文档编号**：DES-20260617-004
**版本**：v1.2.0
**状态**：🟡 草稿
**创建日期**：2026-06-17
**最后更新**：2026-06-26
**作者**：AI 生成
**审核人**：待定
**所属层次**：Layer 3（对外接口层）+ Layer 2（业务逻辑层）+ Layer 4（集成层）
**关联文档**：`doc/arch/dingtalk-opencode_SAD.md` (SAD-20260617-001)

---

## 1. 功能描述

- 功能1：**消息接收与鉴权** — 连接钉钉 Stream WebSocket，注册消息回调，解析 @提及，过滤非 text 类型消息
- 功能2：**项目指令路由** — 识别「项目列表」「切换项目」「当前项目」「重置项目」等指令并路由到对应模块
- 功能3：**消息排队** — 按 sessionKey 串行化处理，同用户排队不同用户并行
- 功能4：**AI 处理循环** — 心跳通知 + 看门狗监控 + do-while 重试（最多 3 次）+ 结果回复构建
- 功能5：**看门狗健康监控** — 并行检测 OpenCode 服务健康 + session 存活，仅记录状态不中断消息；消息超时由 sendMessage 内部超时控制
- 功能6：**钉钉消息发送** — Markdown 和纯文本消息 Webhook 发送，异常内部吞掉不传播
- 功能7：**错误提示** — 按错误类型（超时/服务不可用/处理失败）发送不同提示文本
- 功能8：**强制重启指令** — 用户发送"强制重启"时停止所有服务、持久化会话、触发后台重启脚本后退出
- 功能9：**会话轮次上限与实例回收** — 每轮消息计数，达到 `MAX_ROUNDS_PER_SESSION` 后杀死旧 opencode serve 进程重启新实例，AI 上下文完全清零

---

## 2. 业务规则

| 规则编号 | 规则描述 | 配置来源 |
|----------|----------|---------|
| MSG-REG-01 | 仅处理 @提及 机器人的文本消息，非 @提及 和非 text 类型静默忽略 | 硬编码 |
| MSG-REG-02 | 空消息（仅 @提及 无文字）回复引导提示「你好 xxxx，请描述您的需求」 | 硬编码 |
| MSG-REG-03 | 消息按 sessionKey 串行：同 `projectId:conversationId:senderId` 依次处理 | 硬编码 |
| MSG-REG-04 | AI 处理循环心跳每 60s 向用户发送一次进度通知 | 硬编码（固定 60s） |
| MSG-REG-05 | 重试条件：TypeError("fetch failed") / watchdog restart / 连续 2 次 AbortError | 硬编码 |
| MSG-REG-06 | 最大重试 3 次，指数退避 1s → 2s → 4s（上限 10s） | 硬编码 |
| MSG-REG-07 | 看门狗健康检查连续失败 ≥ 3 次触发 server_down 状态，仅记录日志不中断消息（超时由 sendMessage 内部 1800s 超时控制） | 硬编码 |
| MSG-REG-08 | 看门狗检测到 session 消失触发 restart 状态，仅记录状态供重试判断，不主动打断消息 | 硬编码 |
| MSG-REG-09 | 钉钉消息发送异常内部 catch 日志 warn，不向上传播 | 硬编码 |
| MSG-REG-10 | 非法 JSON 消息日志警告，不回复 | 硬编码 |
| MSG-REG-11 | 全局限流：每秒最多处理 50 个请求，超出时回复"系统繁忙，请稍后再试" | 硬编码（可配置） |
| MSG-REG-12 | 会话轮次上限：每轮消息 `roundCount++`，达到 `MAX_ROUNDS_PER_SESSION` 后回收项目进程并重建 Session；默认项目仅重建 Session 不回收端口 | 环境变量_MAX_ROUNDS_PER_SESSION（默认 0=不限制） |

---

## 3. 接口定义（内部模块接口）

**接口1：handleRobotMessage — 钉钉消息入口**

```typescript
// handleRobotMessage(raw: ArrayBuffer): Promise<void>
// 功能: 钉钉消息回调处理函数
// 入参: raw — 钉钉 Stream 回调原始消息
// 行为:
//   1. JSON.parse → RobotTextMessage
//   2. 非 text 类型 → 忽略
//   3. stripBotMention → 提取纯文本
//   4. 空消息 → dingtalk.sendTextMessage("你好 xxx，请描述您的需求")
//   5. 项目指令 → 路由到 project-registry/server-manager
//   6. 普通消息 → queue.enqueue(sessionKey, processAIMessage)
```

**接口2：processAIMessage — AI 处理循环**

```typescript
// processAIMessage(ctx: AIMessageContext, sessionKey: string, message: string, msg: RobotTextMessage, requestId: string): Promise<void>
// 功能: 核心 AI 处理循环
// 行为:
//   1. heartbeat setInterval(60s) → 进度通知
//   2. do {
//      a. sessions.get(sessionKey)
//         → 有 sessionId → 复用
//         → 无 → createSession(sessionKey) → sessions.set
//      b. new Watchdog(sessionId, signal).start()
//      c. opencode.sendMessage(sessionId, message, signal)
//      d. watchdog.stop()
//      e. clearInterval(heartbeat)
//      f. buildReplyMessage(result, requestId) → dingtalkReply
//      g. dingtalk.sendMessage(webhook, dingtalkReply)
//      } while (shouldRetry)
```

**接口3：buildReplyMessage — 构建回复**

```typescript
// buildReplyMessage(result: string, requestId: string): DingTalkMarkdown
// 功能: 将 AI 回复 JSON 解析为钉钉 Markdown 格式回复
// 返回: { title: string, text: string } — 含任务摘要、文件列表、会话链接
```

**接口4：sendProcessingError — 错误提示**

```typescript
// enum ProcessingErrorType {
//   ServerDown = "server_down",
//   Timeout = "timeout",
//   Network = "network",
//   Unknown = "unknown",
// }
// sendProcessingError(webhook: string, errorType: ProcessingErrorType, error?: Error, requestId?: string): void
// 功能: 按错误类型发送不同提示文本到钉钉
// 行为:
//   ServerDown → "❌ OpenCode 服务暂时不可用"
//   Timeout → "⏰ 任务处理超时"
//   Network → retry（不发送错误提示）
//   其他 → "❌ 处理失败: {错误原因}"
```

**接口5：MessageQueue.enqueue — 消息排队**

```typescript
// enqueue(key: string, fn: () => Promise<void>): void
// 功能: 按 key 入队，同 key 串行不同 key 并行
// 实现: prev = prev.then(fn, fn) → Promise 链
// 清理: 链执行完成后，延迟 1s delete queues[key] 释放 Map 空间
```

**接口7：dingtalk — 钉钉消息发送**

```typescript
// dingtalk.sendMessage(webhook: string, message: DingTalkMarkdown): Promise<void>
// 功能: 发送 Markdown 消息到钉钉 Webhook
// 入参: webhook — 钉钉机器人回调 URL
//       message — { title: string, text: string }
// 出参: void
// 异常: 内部 catch，不抛出（日志 warn）

// dingtalk.sendTextMessage(webhook: string, text: string): Promise<void>
// 功能: 发送纯文本消息到钉钉 Webhook
// 出参: void
// 异常: 内部 catch，不抛出（日志 warn）
```

**接口8：rateLimiter.tryConsume — 全局限流**

```typescript
// rateLimiter.tryConsume(): boolean
// 功能: 尝试消费一个限流令牌
// 返回: true=允许通过, false=限流
// 实现: 滑动窗口/令牌桶，每秒上限 50
```

**接口6：Watchdog — 看门狗**

```typescript
// new Watchdog(sessionId: string)
//   .start(): void — 启动 interval(60s)，每个 tick 执行 checkHealth + checkSession
//   .stop(): void — 清除 interval
//   .state: "running" | "server_down" | "restart" — 当前状态
// 注意：Watchdog 不再持有 AbortController，只监控状态、不中断消息。
//       sendMessage 使用自己内部的 1800s 超时控制。
```

---

## 4. 功能逻辑（详细步骤 + 生产级伪代码）

### handleRobotMessage — 消息入口

```python
async def handleRobotMessage(raw):
    # 步骤0: 生成请求级 TraceId
    request_id = uuid_v4()
    logger.info("收到钉钉消息", request_id)

    # 步骤1: JSON 解析
    try:
        msg = json_parse(raw)
    except JSONError:
        logger.warn("非法 JSON 消息, 已忽略")
        return

    # 步骤2: 仅处理 text 类型
    if msg.msgtype != "text":
        return

    # 步骤3: 提取消息文本，去掉 @提及 前缀
    text = strip_bot_mention(msg.text.content)
    # LANGUAGE_SPECIFIC: TypeScript - 使用正则 /@[^\\s]+/ 替换

    # 步骤4: 空消息处理
    if not text or text.trim() == "":
        greeting = f"你好 {msg.sender.nick}，请描述您的需求"
        dingtalk.sendTextMessage(msg.webhook, greeting)
        return

    # 步骤5: 项目指令识别
    command = parseProjectCommand(text)
    if command:
        executeProjectCommand(command, msg)
        return

    # 步骤6: 解析项目上下文
    project_id = contextStore.get(msg.conversationId, msg.senderId)
    if project_id:
        server_url = serverManager.get(project_id)?.baseUrl
    else:
        if config.PROJECT_SWITCH_REQUIRED:
            dingtalk.sendTextMessage("请先发送「项目列表」选择项目")
            return
        server_url = config.OPENCODE_SERVER_URL

    # 步骤7: 全局限流检查（每秒最多 50 个请求）
    if not rate_limiter.try_consume():
        dingtalk.sendTextMessage(msg.webhook, "系统繁忙，请稍后再试")
        return

    # 步骤8: 构建 sessionKey 并入队
    session_key = f"{project_id || 'default'}:{msg.conversationId}:{msg.senderId}"
    ctx = AIMessageContext(server_url, webhook, ...)
    queue.enqueue(session_key, async () => {
        await dingtalk.sendTextMessage(msg.webhook, "⏳ 已收到消息，正在处理...")
        await processAIMessage(ctx, session_key, text, msg, request_id)
    })
```

### processAIMessage — AI 处理核心循环

```python
async def processAIMessage(ctx, session_key, message, msg, request_id):
    retry_count = 0
    consecutive_abort = 0
    last_error = None

    # 步骤1: 启动心跳
    heartbeat = setInterval(60 * 1000, () => {
        dingtalk.sendTextMessage(ctx.webhook, "⏳ 正在处理中，请稍候...")
    })

    # 步骤2: 重试循环 (do-while)
    do:
        watchdog = null
        session_id = null

        try:
            log = ctx.logger.with_fields(request_id=request_id)  # TraceId 贯穿日志

            # v1.2.0: 步骤2a: 轮次上限检查
            # 每轮消息计数，达到 MAX_ROUNDS_PER_SESSION 后回收项目进程
            if config.maxRoundsPerSession > 0:
                round_count = sessionStore.getRoundCount(session_key)
                if round_count >= config.maxRoundsPerSession:
                    project_id = session_key.split(":")[0]
                    log.info("round limit reached, recycling",
                             rounds=round_count, max=config.maxRoundsPerSession)

                    # 通知用户
                    dingtalk.sendTextMessage(
                        ctx.webhook,
                        f"🔄 已达 {config.maxRoundsPerSession} 轮对话上限，正在回收实例重新启动..."
                    )

                    if project_id != "default" and ctx.recycleProjectSession:
                        # 项目服务：杀死旧进程，重启新实例（所有 session 清零）
                        await ctx.recycleProjectSession(project_id)
                        sessionStore.delete(session_key)
                        sessionStore.resetRound(session_key)
                    else:
                        # 默认项目：不回收端口，只重建 Session
                        sessionStore.delete(session_key)
                        sessionStore.resetRound(session_key)

                # 轮次 +1（无论是否超限，每轮消息计数一次）
                sessionStore.incrementRound(session_key)

            # 步骤2b: 获取或创建 session
            # 首先验证已有 session 是否有效（opencode serve 重启后旧 ID 会失效）
            session_id = sessionStore.get(session_key)
            if session_id:
                exists = await opencode.sessionExists(session_id)
                if exists is False:
                    sessionStore.delete(session_key)
                    session_id = null  # 旧 session 失效，重新创建

            if not session_id:
                session_name = f"钉钉-{sender_nick}"
                session_id = await opencode.createSession(session_name)
                sessionStore.set(session_key, session_id)

            # 步骤2c: 启动看门狗（仅监控，不持有 AbortController）
            # v1.1.0: Watchdog 不再与 sendMessage 共享 AbortController
            watchdog = Watchdog(session_id)
            watchdog.start()

            # 步骤2d: 发送消息并等待 AI 回复
            # TIMEOUT: 由 sendMessage 内部 1800s 超时控制，不再由 watchdog 控制
            result = await opencode.sendMessage(session_id, message)

            # 步骤2e: 处理成功 → 构建并发送回复
            watchdog.stop()
            clearInterval(heartbeat)
            reply = buildReplyMessage(result, request_id)
            dingtalk.sendMessage(ctx.webhook, reply)
            # COMPENSATION: 回复发送失败 → 日志 error，尝试发送简短通知
            return

        except TypeError as e:
            # 网络异常 (fetch failed) — 创建新 session 重试
            if retry_count < 3:
                should_retry = true
                # 创建带时间戳的新 session
                new_session = await opencode.createSession(f"钉钉-{sender_nick}-{timestamp()}")
                session_id = new_session.id
                sessionStore.set(session_key, session_id)
            last_error = ProcessingErrorType.Network

        except AbortError:
            # sendMessage 内部超时 — 创建新 session 重试
            if retry_count < 3:
                should_retry = true
                new_session = await opencode.createSession(f"钉钉-{sender_nick}")
                session_id = new_session.id
                sessionStore.set(session_key, session_id)
            last_error = ProcessingErrorType.Timeout

        except Exception as e:
            should_retry = false  # 非预期错误不重试
            last_error = e

        finally:
            if watchdog:
                watchdog.stop()
            if should_retry:
                retry_count += 1
                # 指数退避: 1s, 2s, 4s
                delay = min(1000 * (2 ** (retry_count - 1)), 10000)
                await sleep(delay)

    while should_retry

    # 步骤3: 重试耗尽 → 发送错误提示
    clearInterval(heartbeat)
    sendProcessingError(ctx.webhook, last_error, request_id=request_id)
```

### MessageQueue — Promise 链串行

```python
class MessageQueue:
    def __init__(self):
        self.queues = {}  # key → Promise 链

    def enqueue(self, key, fn):
        # 获取或初始化当前 key 的 Promise 链
        if key not in self.queues:
            self.queues[key] = Promise.resolve(null)

        # 追加到链尾：无论 prev 成功/失败都执行 fn
        prev = self.queues[key]
        next_task = prev.then(lambda _: fn(), lambda _: fn())
        # LANGUAGE_SPECIFIC: TypeScript - 使用 .then(fn, fn)
        # .then(onFulfilled, onRejected) 两个参数确保无论前面成功失败都执行

        self.queues[key] = next_task

        # 吞掉整条链的最终 rejection（错误已由 handler 处理）
        next_task.catch(lambda _: {})

        # 链完成后延迟清理 key，防止频繁创建销毁
        next_task.finally(lambda _: setTimeout(1000, lambda: self.queues.pop(key, None)))
```

### Watchdog — 健康检测

```python
class Watchdog:
    def __init__(self, session_id):
        self.session_id = session_id
        self.consecutive_failures = 0
        self.state = "running"
        self.timer = null
        # v1.1.0: Watchdog 不再持有 AbortController
        # 只监控状态不中断消息，防止看门狗误判导致消息中断

    def start(self):
        # 启动定时器，每 60s 执行
        self.timer = setInterval(60 * 1000, async () => {
            await self.checkHealth()
            await self.checkSession()
        })

    def stop(self):
        if self.timer:
            clearInterval(self.timer)
            self.timer = null

    async def checkHealth(self):
        try:
            # 使用 quickHealth() — 5s 短超时，适合看门狗轮询
            # 不同于 health() 的 1800s 超时（用于 sendMessage）
            healthy = await opencode.quickHealth()
            if healthy:
                self.consecutive_failures = 0
            else:
                self.consecutive_failures += 1
                if self.consecutive_failures >= 3:
                    self.state = "server_down"
                    # 不再调用 abort()，仅记录状态供错误提示使用
        except:
            self.consecutive_failures += 1
            if self.consecutive_failures >= 3:
                self.state = "server_down"

    async def checkSession(self):
        try:
            exists = await opencode.sessionExists(self.session_id)
            if exists is False:
                # session 确认不存在
                self.state = "restart"
                # 不再调用 abort()，由 ai-handler 重试逻辑检查 state
            # null = API 出错 → 跳过本轮
        except:
            pass  # 异常吞掉，state 不变
```

### dingtalk.sendMessage — 钉钉消息发送

```python
async def sendMessage(webhook, message):
    try:
        response = await http_post(webhook, {
            "msgtype": "markdown",
            "markdown": {
                "title": message.title,
                "text": message.text
            }
        })
        if not response.ok:
            body = await response.text()
            logger.warn("DingTalk 回复失败", webhook, status, body)
    except:
        logger.warn("DingTalk 网络异常", webhook)
    # 不抛出异常——错误已内部处理
```

---

## 5. 状态机与状态流转

### 5.1 Watchdog 状态枚举

```python
class WatchdogState(enum):
    RUNNING = "running"          # 正常运行
    SERVER_DOWN = "server_down"  # 健康检查连续 3 次失败
    RESTART = "restart"          # session 消失
```

### 5.2 合法状态转换表

| 当前状态 | 目标状态 | 触发操作 | 前置条件 | 副作用 |
|---------|---------|---------|---------|--------|
| RUNNING | RUNNING | checkHealth 通过 | consecutiveFailures=0 | — |
| RUNNING | RUNNING | checkHealth 失败 < 3 | consecutiveFailures 递增 | — |
| RUNNING | SERVER_DOWN | checkHealth 失败 = 3 | consecutiveFailures ≥ 3 | 记录状态，不 abort（消息超时由 sendMessage 内部控制） |
| RUNNING | RESTART | checkSession = false | session 确认不存在 | 记录状态，由重试逻辑检查 |
| RUNNING | RUNNING | checkSession = null | API 出错 | 跳过本轮 |

### 5.3 重试状态

| 触发条件 | 重试动作 | 最大次数 | 间隔 |
|---------|---------|---------|------|
| TypeError fetch failed | 创建新 session（含时间戳），重发消息 | 3 | 1s→2s→4s |
| Watchdog RESTART | 验证 session 已不存在后创建新 session，重发消息 | 3 | 1s→2s→4s |
| AbortError（sendMessage 内部超时） | 创建新 session，重发消息 | 3 | 1s→2s→4s |

> v1.1.0 变更：之前 AbortError 可能由 watchdog 触发（共享 AbortController），现已分离。
> AbortError 仅来自 sendMessage 内部的 1800s 请求超时，watchdog 不再触发 abort。

### 5.4 任务状态机（PRD 4.1.1）

每一条用户消息在消息调度中经历以下生命周期状态：

```python
class TaskState(enum):
    RECEIVED  = "received"   # 已接收（handleRobotMessage 解析完成）
    QUEUED    = "queued"     # 已入队（enqueue 成功）
    PROCESSING = "processing" # 处理中（processAIMessage 执行中）
    COMPLETED  = "completed"  # 已完成（AI 成功回复）
    FAILED     = "failed"     # 已失败（重试耗尽）
    TIMEOUT    = "timeout"    # 超时（AbortError 且重试耗尽）
```

合法状态转换：

| 当前状态 | 目标状态 | 触发条件 |
|---------|---------|---------|
| RECEIVED | QUEUED | queue.enqueue(sessionKey, fn) |
| QUEUED | PROCESSING | fn 开始执行 |
| PROCESSING | COMPLETED | buildReplyMessage + dingtalk.sendMessage 成功 |
| PROCESSING | FAILED | 重试 3 次耗尽（TypeError/非预期异常） |
| PROCESSING | TIMEOUT | AbortError 且重试 3 次耗尽 |
| PROCESSING | QUEUED | watchdog.restart 触发重试，入队新 cycle |

---

## 6. 使用的算法

- **指数退避**：`delay = min(1000 * 2^(retryCount-1), 10000)`，首次 1s，逐次加倍，上限 10s
- **消息串行**：Promise 链 `prev.then(fn, fn)` → 无论 prev resolve/reject 都执行 fn

---

## 7. 数据库表结构

不适用——本模块为编排层，无直接数据持久化。

---

## 8. 外部接口（本模块调用的外部系统）

| 接口名称 | 协议/URL | 请求/响应格式 | 说明 |
|----------|----------|---------------|------|
| 钉钉 Stream 回调 | WebSocket (DWClient) | 入参：ArrayBuffer | 接收用户消息回调 |
| 钉钉 Webhook | `POST {webhook}` | 请求：`{ msgtype, text/markdown }`；出参：无（fire-and-forget） | 发送回复到群聊 |

---

## 9. 内部接口（供其他模块调用）

本模块为顶层编排模块，不为其他模块提供接口（index.ts 是入口，ai-handler.ts 通过 queue.enqueue 被调用）。

**本模块调用的内部接口**：
- `opencode.sendMessage / createSession / shareSession / health / sessionExists`
- `dingtalk.sendMessage / sendTextMessage`
- `sessionStore.get / set`
- `serverManager.get / startProject / checkProject / list`
- `projectRegistry.findById / findByName`
- `contextStore.get / set`
- `config` 配置对象

---

## 10. 性能要求

| 接口 | 响应时间（P95） | TPS 目标 |
|------|----------------|---------|
| 消息接收到确认回复 | ≤ 2s | ≥ 5 tps |
| 心跳通知 | 每 60s 一次 | N/A |
| 消息队列 enqueue | ≤ 10ms | ≥ 100 tps |
| 看门狗健康检查 | ≤ 2s | 每 60s 执行 |
| 钉钉消息发送 | ≤ 3s | fire-and-forget |

---

## 11. 安全要求

- **鉴权**：仅处理 @提及 机器人消息，非 @提及 忽略，防止冒充
- **防注入**：消息文本不直接拼接执行，仅作为文本传递给 OpenCode API
- **异常隔离**：钉钉发送异常内部吞掉，不传播到主流程
- **超时控制**：所有 HTTP 调用受超时和 AbortSignal 控制，防止资源泄漏
- **日志安全**：不记录消息原文，仅记录元数据（senderId、长度、处理结果）

---

## 12. 测试要点

| 测试点 | 输入 | 预期输出 | 备注 |
|--------|------|----------|------|
| 正常消息处理 | 合法文本消息 | 已收到 → 处理中 → 结果回复 | 全链路 |
| 空消息（仅 @提及） | 仅 @提及 无文字 | 回复引导提示 | — |
| 非 text 类型消息 | 图片/语音消息 | 忽略，不回复 | — |
| 非法 JSON | 损坏的原始数据 | 日志警告，不回复 | — |
| 消息排队 — 同 key 串行 | 同一用户连续 2 条 | 第 2 条在第 1 条完成后执行 | — |
| 消息排队 — 不同 key 并行 | 不同用户各 1 条 | 同时执行 | — |
| 前序任务失败 | 第 1 个任务出错 | 第 2 个任务仍然执行 | — |
| session 首次创建 | 无已有 session | createSession 被调用 | — |
| session 已存在 | 已有 session | 复用 sessionId | — |
| session 失效（opencode 重启） | 旧 sessionId 返回 false | 验证 sessionExists，删除旧 session 重新创建 | v1.1.0 新增 |
| 处理成功 | 正常 AI 回复 | 心跳清除，结果回复到钉钉 | — |
| 钉钉回复失败 | webhook 不可达 | 日志 error，发送简短通知 | v1.1.0 变更 |
| 看门狗 restart | session 消失 | state="restart"，ai-handler 检查重试（最多 3 次） | 不再 abort |
| 看门狗 server_down | 连续 3 次 health 失败 | state="server_down"，仅用于错误提示 | 不再 abort |
| 看门狗不持有 AbortController | Watchdog(sessionId) 构造 | 无 signal 传出，不对 sendMessage 产生影响 | v1.1.0 变更 |
| quickHealth 5s 超时 | 服务无响应 | 5s 后返回 false | v1.1.0 新增 |
| 超时 (AbortError) | AI 处理超时 1800s | 创建新 session 重试，提示"任务超时" | 来自 sendMessage 内部超时 |
| 重试耗尽 | 连续 3 次失败 | 发送处理失败提示 | — |
| 全局限流 — 正常 | 每秒 30 个请求 | 全部正常处理 | — |
| 全局限流 — 超限 | 每秒 60 个请求 | 超出部分返回"系统繁忙" | 验证 MSG-REG-11 |
| TraceId 贯穿 | 入口生成 requestId | processAIMessage / buildReplyMessage / sendProcessingError 均携带 | 验证 REVIEW-DES-006 |
| MessageQueue 清理 | 链完成后等待 1s | queues 中对应 key 被 pop | 验证 REVIEW-DES-005 |
| 错误枚举 | TypeError 触发 | last_error = ProcessingErrorType.Network | 验证 REVIEW-DES-007 |
| 任务状态机 | 消息从 RECEIVED → COMPLETED | 全链路状态转换可追踪 | 验证 REVIEW-DES-008 |
| ContextStore delete | sessionId 绑定 | 删除后 get 返回 undefined | 验证 REVIEW-DES-002 |
| 指数退避间隔 | 第 1/2/3 次重试 | 1s / 2s / 4s 间隔 | — |

---

## 13. 依赖关系

- **依赖其他模块**：
  - `opencode.ts` — `sendMessage / createSession / shareSession / health / sessionExists`
  - `session-store.ts` — `get / set`
  - `project-context-store.ts` — `get / set`
  - `server-manager.ts` — `get / startProject / checkProject / list`
  - `project-registry.ts` — `findById / findByName`
  - `config.ts` — 配置对象
- **被其他模块依赖**：无（本模块为顶层入口）

---

## 变更记录

| 版本 | 日期 | 变更类型 | 变更内容摘要 | 变更人 |
|------|------|---------|------------|--------|
| v1.0.0 | 2026-06-17 | 🆕 新建 | 初始版本 | AI 生成 |
| v1.0.1 | 2026-06-17 | ✏️ 修改 | 同步架构评审：补充全局限流 MSG-REG-11、handleRobotMessage 新增限流步骤 | AI 生成 |
| v1.0.2 | 2026-06-17 | ✏️ 修改 | 同步详设评审：dingtalk §3 接口定义、错误枚举、TraceId、MessageQueue 清理、任务状态机 | AI 生成 |
| v1.1.0 | 2026-06-18 | ✏️ 修改 | Watchdog 与 sendMessage 解耦：移除共享 AbortController，watchdog 改用 quickHealth()（5s 超时），仅监控不中断消息；processAIMessage 新增 session 失效验证；新增强制重启指令 | AI 生成 |
| v1.2.0 | 2026-06-26 | ✨ 新增 | 会话轮次上限与实例回收：processAIMessage 入口检查 roundCount，超限回收项目端口重建实例；新增 MSG-REG-12 | AI 生成 |
