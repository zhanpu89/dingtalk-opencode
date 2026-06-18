# dingtalk-opencode — OpenCode API客户端 详细设计文档

**文档编号**：DES-20260617-003
**版本**：v1.0.0
**状态**：🟡 草稿
**创建日期**：2026-06-17
**最后更新**：2026-06-17
**作者**：AI 生成
**审核人**：待定
**所属层次**：Layer 4（集成层）
**关联文档**：`doc/arch/dingtalk-opencode_SAD.md` (SAD-20260617-001)

---

## 1. 功能描述

- 功能1：**流式消息发送** — 向 OpenCode 会话发送消息，通过 HTTP POST 流式读取 AI 返回结果，支持外部 AbortSignal 中止
- 功能2：**Session 生命周期** — 创建新 session（先查后建避免重复）、查询 session 是否存在（三级语义：true/false/null）、分享 session 生成链接
- 功能3：**服务健康检查** — 调用 `GET /global/health` 检测 OpenCode 服务可用性

---

## 2. 业务规则

| 规则编号 | 规则描述 | 配置来源 |
|----------|----------|---------|
| OPC-REG-01 | `sendMessage` 分两阶段：Phase 1 HTTP POST 连接（含超时）→ Phase 2 流式 chunk 读取 | 硬编码 |
| OPC-REG-02 | Phase 1 超时通过 `AbortSignal.timeout(timeoutMs)` 控制，超时抛出 AbortError | 硬编码（timeoutMs 入参） |
| OPC-REG-03 | 外部 AbortSignal（看门狗触发）可随时中止 Phase 2 流读取 | 硬编码 |
| OPC-REG-04 | `sessionExists` 返回三级语义：true=存在、false=不存在、null=API 出错（区别于不存在） | 硬编码 |
| OPC-REG-05 | `createSession` 先查后建：同名 session 存在时 GET 查找复用，不存在时 POST 新建 | 硬编码 |
| OPC-REG-06 | `shareSession` 失败时不抛出异常，仅日志 warn，返回 null | 硬编码 |
| OPC-REG-07 | `health` API 异常时吞掉异常返回 false，不向上传播 | 硬编码 |

---

## 3. 接口定义（内部模块接口）

**接口1：sendMessage — 流式消息发送**

```typescript
// sendMessage(sessionId: string, message: string, signal?: AbortSignal): Promise<string>
// 功能: 向 OpenCode 会话发送消息，流式读取并拼接 AI 回复
// 入参:
//   sessionId: OpenCode 会话 ID
//   message: 用户消息文本
//   signal: 可选的外部 AbortSignal（看门狗驱动）
// 返回: 拼接后的完整 AI 回复 JSON 字符串
// 异常:
//   AbortError — Phase 1 超时 / 外部 signal 触发中止
//   Error — HTTP 非 200 响应（含 status + body）
```

**接口2：sessionExists — 会话存在性查询**

```typescript
// sessionExists(sessionId: string): Promise<boolean | null>
// 功能: 查询指定 sessionId 是否存在
// 返回:
//   true — session 存在
//   false — session 不存在（触发重启）
//   null — API 错误（跳过本轮检查，不误判 restart）
```

**接口3：createSession — 创建新会话**

```typescript
// createSession(sessionName: string): Promise<string>
// 功能: 创建新的 OpenCode AI 会话
// 入参: sessionName — 会话名称（由调用方生成，含时间戳避免冲突）
// 返回: sessionId
// 行为: 先 GET /session 查找同名 → 存在则复用；不存在则 POST /session 新建
```

**接口4：shareSession — 分享会话**

```typescript
// shareSession(sessionId: string): Promise<string | null>
// 功能: 生成会话分享链接
// 返回: shareURL（成功）/ null（失败）
```

**接口5：health — 服务健康检查**

```typescript
// health(): Promise<boolean>
// 功能: 检查 OpenCode 服务是否可用
// 返回: true（200 OK）/ false（非 200 或异常）
```

---

## 4. 功能逻辑（详细步骤 + 生产级伪代码）

### sendMessage — 流式消息发送

```python
async def sendMessage(session_id, message, external_signal=None):
    # Phase 1: HTTP POST 连接
    # 步骤1: 创建组合 AbortController
    controller = AbortController()
    timeout_ms = external_timeout or default_timeout

    # 步骤2: 创建 Phase 1 超时信号
    timeout_signal = AbortSignal_timeout(timeout_ms)
    # LANGUAGE_SPECIFIC: TypeScript - 使用 AbortSignal.timeout(timeoutMs)

    # 步骤3: 组合外部 signal + 超时 signal
    combined_signal = combine_signals(external_signal, timeout_signal, controller.signal)
    # 外部 signal 来自 watchdoc，触发后停止流读取

    # 步骤4: 发送 POST 请求
    response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: json_stringify({ "message": message, "session_id": session_id }),
        signal: combined_signal,
    })
    # TIMEOUT: timeoutMs — Phase 1 连接超时

    # 步骤5: 检查 HTTP 状态
    if not response.ok:
        body = await response.text()
        raise Error("OpenCode API 非 200 响应: {status} {body}")

    # Phase 2: 流式读取
    # 步骤6: 获取 reader 并逐 chunk 拼接
    reader = response.body.getReader()
    decoder = TextDecoder()
    result = ""
    # FINALLY: 确保 reader 释放
    try:
        while true:
            # 步骤7: 读取下一 chunk
            # 外部 signal 触发时，fetch 流自动抛出 AbortError
            {done, value} = await reader.read()
            if done:
                break
            # 步骤8: 解码并拼接
            chunk = decoder.decode(value, {stream: true})
            result += chunk
            # LANGUAGE_SPECIFIC: TypeScript - 使用 TextDecoder
    finally:
        reader.releaseLock()

    # 步骤9: 返回完整结果
    return result
```

### sessionExists — 三级语义查询

```python
async def sessionExists(session_id):
    try:
        response = await http_get(f"{baseUrl}/session?id={session_id}")
        # 步骤1: 解析响应
        if response.ok:
            body = await response.json()
            return body is not None  # true = 存在
        else:
            return False  # false = 确认不存在

    except Exception:
        # 步骤2: 网络异常 → 返回 null，不误判
        logger.warn("检查 session 存在性时 API 错误", session_id)
        return None  # null = API 出错，跳过本轮
```

### createSession — 先查后建

```python
async def createSession(session_name):
    # 步骤1: 先查找同名 session
    response = await http_get(f"{baseUrl}/session?name={session_name}")

    if response.ok:
        body = await response.json()
        if body and body.id:
            # 已存在 → 复用
            logger.info("复用已有 session", session_name)
            return body.id

    # 步骤2: 不存在 → 新建
    response = await http_post(f"{baseUrl}/session", {"name": session_name})
    if response.ok:
        body = await response.json()
        return body.id

    # 步骤3: 创建失败
    raise Error("创建 session 失败: {status}")
```

---

## 5. 状态机与状态流转

不适用——本模块为无状态 API 客户端，不维护状态实体。

---

## 6. 使用的算法

- **TextDecoder 流解码**：`TextDecoder.decode(chunk, { stream: true })` 处理多字节字符跨 chunk 边界的情况，确保不出现乱码

---

## 7. 数据库表结构

不适用——本模块无数据持久化。

---

## 8. 外部接口（本模块调用的外部系统）

| 接口名称 | 协议/URL | 请求/响应格式 | 说明 |
|----------|----------|---------------|------|
| OpenCode 发送消息 | `POST {baseUrl}/{sessionId}/message` | 请求: `{ message: string }`；响应: stream (text/event-stream) | 流式 AI 回复 |
| OpenCode 查询 session | `GET {baseUrl}/session?{name|id}` | 响应: `{ id: string, name: string, ... }` | 查 session 存在性 |
| OpenCode 创建 session | `POST {baseUrl}/session` | 请求: `{ name: string }`；响应: `{ id: string }` | 新建 session |
| OpenCode 分享 session | `POST {baseUrl}/session/{id}/share` | 响应: `{ shareUrl: string }` | 生成分享链接 |
| OpenCode 健康检查 | `GET {baseUrl}/global/health` | 响应: 200 OK | 检测服务可用性 |

---

## 9. 内部接口（供其他模块调用）

**接口：`sendMessage(sessionId, message, signal)`**
- **用途**：ai-handler.ts 在 `processAIMessage` 中调用，将用户消息发给 OpenCode 并接收 AI 回复
- **调用约定**：超时由外部 AbortSignal 控制（看门狗驱动），调用方确保 signal 有效

**接口：`sessionExists(sessionId)`**
- **用途**：watchdog.ts 在 `checkSession` 中调用，检测 session 是否仍然存活

**接口：`createSession(sessionName)`**
- **用途**：ai-handler.ts 在首次处理或重试时调用，创建新 AI 会话

**接口：`shareSession(sessionId)`**
- **用途**：ai-handler.ts 在处理完成时调用，生成会话链接附在回复中

**接口：`health()`**
- **用途**：watchdog.ts 在 `checkHealth` 中调用，周期性检测服务健康

---

## 10. 性能要求

| 接口 | 响应时间（P95） | TPS 目标 |
|------|----------------|---------|
| sendMessage Phase 1 | ≤ 5s（连接 + 首字节） | — |
| sendMessage Phase 2 | 取决于 AI 回复长度 | — |
| sessionExists | ≤ 2s | N/A（看门狗每 60s 调用） |
| createSession | ≤ 3s | N/A（偶发调用） |
| health | ≤ 2s | N/A（看门狗每 60s 调用） |

---

## 11. 安全要求

- **传输安全**：OpenCode API 通过内网 HTTP 调用（127.0.0.1），无需额外加密
- **认证方式**：OpenCode API 内部认证（由 OpenCode 服务管理，本模块透传）
- **超时防护**：所有 HTTP 调用均有超时控制，防止连接泄漏

---

## 12. 测试要点

| 测试点 | 输入 | 预期输出 | 备注 |
|--------|------|----------|------|
| 正常流式响应 | 单次 fetch 返回完整 JSON | 正确解析并返回 | Mock fetch |
| 分块到达 | 多个 chunk 模拟 | 拼接后 JSON.parse 正确 | 验证跨 chunk 拼接 |
| Phase 1 超时 | 设置短 timeoutMs | 抛出 AbortError | 验证 timer 清理 |
| 外部 AbortSignal 触发 | Phase 2 中触发 signal | 流中断，抛出 AbortError | — |
| 外部 signal 调用前已 abort | 已 abort 的 signal | fetch 立即拒绝 | — |
| HTTP 非 200 | 返回 500 | throw Error(status + body) | — |
| sessionExists — 存在 | 返回 body.id | true | — |
| sessionExists — 不存在 | 返回 404 | false | — |
| sessionExists — API 错误 | fetch throw | null | 验证不抛异常 |
| createSession — 新建 | 同名不存在 | POST 调用，返回新 id | — |
| createSession — 复用 | 同名已存在 | GET 查到并复用 | — |
| shareSession — 成功 | 返回 shareUrl | 返回 URL | — |
| shareSession — 失败 | API 异常 | 返回 null，日志 warn | — |
| health — 正常 | 200 OK | true | — |
| health — 异常 | 非 200 或 throw | false | — |

---

## 13. 依赖关系

- **依赖其他模块**：无（仅依赖全局 `fetch`）
- **被其他模块依赖**：
  - `ai-handler.ts` 依赖 `sendMessage / createSession / shareSession`
  - `watchdog.ts` 依赖 `health / sessionExists`
  - `server-manager.ts` 依赖 `health`（启动后健康检查轮询）

---

## 变更记录

| 版本 | 日期 | 变更类型 | 变更内容摘要 | 变更人 |
|------|------|---------|------------|--------|
| v1.0.0 | 2026-06-17 | 🆕 新建 | 初始版本 | AI 生成 |
