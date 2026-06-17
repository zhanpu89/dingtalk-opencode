# dingtalk-opencode 设计文档

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                      DingTalk Server                        │
│    (WebSocket Stream Mode)                                  │
└───────────────┬─────────────────────────────────────────────┘
                │ 回调消息 (robot message callback)
                ▼
┌─────────────────────────────────────────────────────────────┐
│                   index.ts (入口 + 路由)                      │
│                                                             │
│  ┌────────────┐  ┌──────────────────────────────────────┐  │
│  │  Message   │  │ ┌──────────┐  ┌──────────────────┐  │  │
│  │  Queue     │─→│ │ process- │→│ buildReplyMessage │  │  │
│  │            │  │ │ AIMessage│  │ sendProcessingErr │  │  │
│  └────────────┘  │ │ (重试循环)│  └──────────────────┘  │  │
│                  │ └──────────┘                         │  │
│                  │  ai-handler.ts                       │  │
│                  └──────────────────────────────────────┘  │
└────────────────────────┼──────────────────────────────────┘
                         │
         ┌───────────────┼───────────────────┬────────────────┐
         ▼               ▼                   ▼                ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
│  opencode.ts │ │  dingtalk.ts │ │ session-     │ │ server-manager.ts│
│  (API客户端)  │ │  (消息发送)   │ │ store.ts     │ │ (统一服务管理)    │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────────┘
                                                         │
                                              ┌──────────┴──────────┐
                                              ▼                     ▼
                                     ┌──────────────┐   ┌──────────────────┐
                                     │ 默认 opencode│   │ 项目 opencode    │
                                     │  serve       │   │  serve (动态)    │
                                     └──────────────┘   └──────────────────┘
```

## 2. 组件设计

### 2.1 入口编排 (`src/index.ts` + `src/ai-handler.ts`)

**`index.ts` 职责**（~390 行，薄路由层）：
- 连接钉钉 Stream（WebSocket），注册消息回调
- 消息解析、鉴权（@提及过滤）
- 将实际 AI 处理委托给 `processAIMessage` (ai-handler.ts)
- 导出预绑定参数的 `sendProcessingError` 包装函数（兼容旧调用方签名）
- 启动 `streamSupervisor` 检测钉钉连接健康

**`ai-handler.ts` 职责**：
- 核心 AI 处理循环（心跳、看门狗、重试、结果回复）
- 纯函数 `buildReplyMessage()` — 构建 Markdown 回复
- 纯函数 `sendProcessingError()` — 按错误类型发送不同提示文本
- 单一入口 `processAIMessage(ctx, sessionKey, message, msg)` 接收 `AIMessageContext` 聚合对象

**核心流程**：

```
handleRobotMessage(raw)              ← index.ts
  ├─ JSON.parse → RobotTextMessage
  ├─ stripBotMention → 提取纯文本
  ├─ dingtalk.sendTextMessage("已收到消息...")
  └─ queue.enqueue(sessionKey, async () => {
       └─ processAIMessage(ctx, sessionKey, message, msg)  ← ai-handler.ts
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
| 看门狗 restart 触发 | 创建新 session，重新发送消息（最多 3 次，指数退避） |
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

### 2.7 多项目预配置与动态 OpenCode 实例

**目标**：
- 让钉钉用户通过项目编号或项目名称切换实际项目
- 每个项目在自己的目录下启动 `opencode serve`，确保项目内 `opencode.json`、AGENTS.md、自定义工具、MCP、权限配置按项目生效
- 避免用户在钉钉中手动输入绝对路径导致错误或安全风险

**项目配置文件**：

默认路径：`projects.json`，可通过 `PROJECTS_CONFIG_PATH` 覆盖。

```json
[
  {
    "id": "stock",
    "name": "量化交易系统",
    "path": "/root/project/stock-app",
    "description": "A 股量化交易与模拟盘系统"
  },
  {
    "id": "bot",
    "name": "钉钉中间件",
    "path": "/root/project/dingtalk-opencode",
    "description": "钉钉机器人到 OpenCode 的桥接服务"
  }
]
```

**配置规则**：
- `id` 必须唯一，建议使用短英文或数字编号
- `name` 必须唯一或至少不产生歧义
- `path` 必须是绝对路径
- 启动时校验：路径存在、是目录、位于 `ALLOWED_PROJECT_ROOTS` 允许范围内
- 可选校验项目标识：`.git`、`opencode.json`、`AGENTS.md`、`package.json`、`pyproject.toml`、`go.mod` 任一存在即可，否则给出 warn

**新增环境变量**：

| 环境变量 | 必填 | 默认值 | 说明 |
|---------|------|--------|------|
| `PROJECTS_CONFIG_PATH` | 否 | `projects.json` | 项目列表配置文件 |
| `ALLOWED_PROJECT_ROOTS` | 是 | - | 允许启动的项目根目录，逗号分隔 |
| `PROJECT_SERVER_PORT_START` | 否 | `4100` | 动态项目 opencode 服务起始端口 |
| `PROJECT_SERVER_HOSTNAME` | 否 | `127.0.0.1` | 动态项目服务监听地址 |
| `PROJECT_SERVER_IDLE_MS` | 否 | `7200000` | 项目实例空闲回收时间，0 表示不回收 |
| `PROJECT_SWITCH_REQUIRED` | 否 | `false` | 是否要求用户先选择项目再处理普通任务 |

**钉钉指令设计**：

| 指令 | 行为 |
|------|------|
| `项目列表` / `获取所有项目` | 返回项目编号、项目名称、项目路径、运行状态表格 |
| `切换项目 <id>` | 按项目编号切换当前钉钉会话项目 |
| `切换项目 <name>` | 按项目名称切换当前钉钉会话项目 |
| `使用项目 <id/name>` | `切换项目` 的别名 |
| `当前项目` | 返回当前会话绑定的项目 |
| `重置项目` | 清除当前会话绑定项目，回到默认 OpenCode 服务 |

**项目列表回复格式**：

```markdown
| 编号 | 项目名称 | 状态 | 路径 |
|------|----------|------|------|
| stock | 量化交易系统 | 运行中 :4100 | /root/project/stock-app |
| bot | 钉钉中间件 | 未启动 | /root/project/dingtalk-opencode |
```

**核心运行流程**：

```
handleRobotMessage(raw)
  ├─ parseProjectCommand(message)
  │   ├─ 项目列表 → ProjectRegistry.list() → 回复表格 → return
  │   ├─ 切换项目 → serverManager.startProject(project)
  │   │              ├─ 已启动 → 复用 baseUrl
  │   │              └─ 未启动 → spawn("opencode", ["serve", "--port", port], { cwd: project.path })
  │   │              → 保存 conversationProjectStore[conversationId:userId] = project.id
  │   │              → 回复切换成功 → return
  │   ├─ 当前项目 → 回复当前绑定项目 → return
  │   └─ 重置项目 → 删除绑定 → return
  ├─ resolveCurrentProject(conversationId, senderId)
  │   ├─ 有绑定项目 → 使用项目专属 OpenCodeClient(baseUrl)
  │   ├─ 无绑定且 PROJECT_SWITCH_REQUIRED=true → 提示先发送“项目列表/切换项目” → return
  │   └─ 无绑定 → 使用默认 OPENCODE_SERVER_URL
  ├─ sessionKey = `${projectId || "default"}:${conversationId}:${senderId}`
  └─ queue.enqueue(sessionKey, ...)
```

**模块清单**：

| 模块 | 职责 |
|------|------|
| `index.ts` | 薄路由层：连接 DingTalk Stream、消息解析、项目指令分发、queue 入队 |
| `ai-handler.ts` | AI 处理循环：心跳、看门狗、重试（最多 3 次网络错误）、`buildReplyMessage` / `sendProcessingError` |
| `opencode.ts` | 封装 opencode HTTP API 调用（流式消息、session 管理） |
| `dingtalk.ts` | 封装钉钉 Webhook 消息发送 |
| `session-store.ts` | 钉钉会话 ↔ OpenCode session ID 的持久化映射（带 2s flush 防抖） |
| `message-queue.ts` | 按 sessionKey 串行化消息处理 |
| `watchdog.ts` | 并行健康检查 + session 存活检测，通过 AbortController 中止流读取 |
| `server-manager.ts` | **统一服务管理**：合并默认服务 + 项目动态服务；背景健康检查每 30s；默认服务自动重启；项目服务端口复用 |
| `project-registry.ts` | 加载、校验、查询 `projects.json` |
| `project-context-store.ts` | 持久化钉钉会话当前项目绑定 |
| `config.ts` | 环境变量加载与配置校验 |

**ServerManager 统一服务管理**（取代旧 `DefaultServerManager` + `ProjectServerManager`）：

- `start()` / `stop()` — 默认 opencode serve 生命周期
- `startProject(project)` — 动态启动项目级 opencode serve
- `checkProject(projectId)` → `{ running, port }` — 查项目服务状态
- `list()` → 所有项目实例列表
- `get(projectId)` → 单个实例
- 状态结构 `ServerInstance`：

```ts
interface ServerInstance {
  id: string;            // "default" | projectId
  type: "default" | "project";
  projectPath?: string;
  port: number;
  baseUrl: string;
  process?: ChildProcess;
  pid?: number;
  startedAt: number;
  lastUsedAt: number;
  status: "starting" | "running" | "failed" | "stopped";
}
```

**端口分配策略**：
- 从 `PROJECT_SERVER_PORT_START` 开始递增扫描
- 启动前检查端口是否可监听
- 如果配置项目已存在运行实例，直接复用
- 如果进程退出但用户再次切换到该项目，重新分配端口并启动

**启动成功判定**：
- spawn 后轮询 `GET /global/health`
- 默认最多等待 30 秒
- 成功后返回 `baseUrl`
- 失败则终止进程，标记 `failed`，回复用户启动失败原因

**会话隔离策略**：
- OpenCode session 映射必须包含项目维度：`projectId:conversationId:senderId`
- 不同项目之间不能复用 sessionId
- 项目切换后，后续普通消息默认进入新项目的 session
- `重置项目` 不删除历史 session，只清除当前绑定

**安全策略**：
- 只允许启动 `projects.json` 中声明的项目
- `realpath(project.path)` 后必须位于 `ALLOWED_PROJECT_ROOTS` 之一
- 不从自由文本中直接执行任意路径
- 不允许用户通过钉钉传入端口、启动参数或 shell 命令
- 动态服务默认只监听 `127.0.0.1`

**资源回收策略**：
- 一期可只实现进程退出时统一关闭所有子实例
- 二期增加 `PROJECT_SERVER_IDLE_MS`，定期关闭长时间未使用的项目实例
- 收到 SIGTERM/SIGINT 时按顺序关闭：钉钉 Stream → 项目 opencode 子进程 → session/context store flush

**用户体验规则**：
- 用户发送普通任务但未选项目：
  - `PROJECT_SWITCH_REQUIRED=true`：提示先发送 `项目列表` 并 `切换项目 <编号>`
  - `false`：使用默认项目处理
- 用户切换到未启动项目：回复“正在启动项目服务...”，启动成功后回复端口和项目名
- 用户切换到已启动项目：立即回复“已切换到项目 xxx”
- 用户当前已在目标项目：回复“当前已在项目 xxx，将直接处理后续任务”

**测试要点**：

| 场景 | 验证点 |
|------|--------|
| 加载 projects.json | 正确解析项目 id/name/path |
| 重复 id/name | 启动时报错或配置校验失败 |
| 非法路径 | 拒绝启动并提示配置错误 |
| 路径不在 ALLOWED_PROJECT_ROOTS | 拒绝启动 |
| 项目列表指令 | 返回 Markdown 表格 |
| 切换项目 id/name | 启动或复用对应 opencode 服务 |
| 当前项目指令 | 返回当前绑定项目 |
| 重置项目指令 | 清除当前绑定 |
| 未选项目且强制选择 | 拦截普通任务并提示先选项目 |
| 不同项目 sessionKey | session 不串项目 |
| 子进程异常退出 | 状态更新为 stopped/failed，后续可重启 |
| SIGTERM/SIGINT | 子进程全部关闭 |

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

### 3.5 Retry 策略（最多 3 次）

`processAIMessage` 中三种场景触发重试，各有不同的判断条件：

| 触发条件 | 重试动作 | 最多重试 |
|---------|---------|---------|
| `TypeError("fetch failed")` 网络错误 | 创建新 session（带上时间戳避免同名冲突），重发消息 | 3 次 |
| 看门狗 `restart` 状态（session 消失） | 创建新 session，重发消息 | 3 次 |
| 连续 2 次 `AbortError`（上下文撑爆） | 删除旧 session，创建新 session，重发消息 | 3 次 |

**设计理由**：
- 需要 retry 的场景都是 transient 问题（网络抖动、session 过期、上下文满）
- 限制 3 次避免无限循环，同时给网络短暂恢复留出空间
- 重试间隔指数退避：1s → 2s → 4s（最大 10s）
- 重试成功 → 用户无感知；重试耗尽 → 发送 `sendProcessingError` 提示

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
