# Session 存储 测试用例

---
文档编号：TC-20260615-005
版本：v1.0.0
状态：🟡 草稿
创建日期：2026-06-15
最后更新：2026-06-15
作者：AI-Tester
关联文档：
  - 详设文档：docs/design.md（§2.5 Session 存储）
---

## 1. 测试范围

- **被测模块**：Session 存储（`src/session-store.ts`——钉钉会话↔OpenCode session ID 持久化映射，2s 防抖 flush）
- **被测接口**：
  - `get(key)`
  - `set(key, sessionId)`
  - `size()`
  - `flush()`
- **用例总数**：9 条（单元测试 9）
- **关联业务规则**：BR-SESS-001~BR-SESS-007
- **关联代码评审报告**：无

---

## 2. 全局前置条件

1. Mock `fs` 模块（`existsSync`、`readFileSync`、`writeFileSync`、`mkdirSync`）
2. Mock `Logger`
3. 使用 `jest.useFakeTimers()` 控制 setTimeout（flush 防抖）

---

## 3. 单元测试用例（UNIT）

### 业务规则覆盖用例

| 用例 ID | 用例标题 | 优先级 | 关联规则 | 前置条件 | 测试步骤 | 预期结果 | 备注 |
|--------|---------|-------|---------|---------|---------|---------|-----|
| TC-SESS-UNIT-001 | 首次启动文件不存在——创建空文件 | P0 | BR-SESS-001 | Mock `fs.existsSync` 返回 false | 1. 构造 SessionStore 2. 验证 `fs.mkdirSync` 被调用（创建目录） | 初始 size = 0，log.info 记录创建路径 | |
| TC-SESS-UNIT-002 | set + flush——JSON 文件正确写入 | P0 | BR-SESS-002 | Mock `fs.existsSync` 返回 true（文件已存在） | 1. 构造 SessionStore 2. 调用 `set("key1", "sid1")` 3. 调用 `flush()` | `fs.writeFileSync` 被调用，写入 JSON `{"key1":"sid1"}` | |
| TC-SESS-UNIT-003 | 程序启动加载——文件内容正确恢复为 Map | P1 | BR-SESS-003 | Mock `fs.existsSync` 返回 true；Mock `fs.readFileSync` 返回 `{"k1":"v1","k2":"v2"}` | 1. 构造 SessionStore 2. 调用 `get("k1")` 3. 调用 `get("k2")` | get("k1")="v1"，get("k2")="v2"，size=2 | |
| TC-SESS-UNIT-004 | 多次 set 不频繁写盘——2s 内仅 flush 一次 | P1 | BR-SESS-004 | 使用 FakeTimers；`fs.existsSync` 返回 true | 1. 构造 SessionStore 2. set("k1","v1") 3. set("k2","v2") 4. set("k3","v3") 5. 前进 2s | flush 仅触发 1 次（防抖生效），writeFileSync 被调用 1 次 | |
| TC-SESS-UNIT-005 | 文件损坏——日志错误，空 Map 启动 | P1 | BR-SESS-005 | Mock `fs.existsSync` 返回 true；`fs.readFileSync` 返回非法 JSON | 1. 构造 SessionStore 2. 验证 | JSON.parse 抛出异常 → log.error 被调用 → map 为空，size=0 | |
| TC-SESS-UNIT-006 | get 不存在 key——返回 undefined | P1 | BR-SESS-006 | 构造空 SessionStore | 1. `get("nonexistent")` | 返回 undefined | |
| TC-SESS-UNIT-007 | size——返回正确条目数 | P1 | BR-SESS-007 | 已有 2 个条目 | 1. set("k1","v1") 2. set("k2","v2") 3. size() | 返回 2 | |

### 分支覆盖用例

| 用例 ID | 用例标题 | 优先级 | 对应分支 | 前置条件 | 测试步骤 | 预期结果 | 备注 |
|--------|---------|-------|---------|---------|---------|---------|-----|
| TC-SESS-UNIT-008 | flush——dirty=false 时直接返回 | P2 | `this.dirty` 为 false | 构造后未执行任何 set | 1. 调用 `flush()` | writeFileSync 不被调用 | |
| TC-SESS-UNIT-009 | flush——writeFileSync 异常被 catch | P2 | writeFileSync 抛出异常 | Mock `fs.writeFileSync` 抛出异常 | 1. set("k1","v1") 2. flush() | 异常被 catch，log.error 被调用 | |

---

## 4. 集成测试用例（INTG）

本模块无集成测试用例（SessionStore 被入口编排集成测试覆盖）

---

## 5. 安全测试用例（SEC）

本模块无安全测试用例（模块为本地文件存储，不涉及网络认证/授权/注入）

---

## 6. 性能测试用例（PERF）

本模块无性能测试用例（模块为本地文件 I/O，非性能瓶颈点）

---

## 7. 前端测试用例（FE）

本模块无前端测试用例（纯后端项目）

---

## 8. 用例统计

| 类型 | 数量 | 优先级分布 |
|-----|-----|---------|
| 单元测试（UNIT） | 9 | P0: 2 / P1: 5 / P2: 2 |
| 集成测试（INTG） | 0 | - |
| 安全测试（SEC） | 0 | - |
| 性能测试（PERF） | 0 | - |
| 前端测试（FE） | 0 | - |
| **合计** | **9** | P0: 2 / P1: 5 / P2: 2 |

其中 `[评审专项]` 用例：0 条

---

## 变更记录

| 版本 | 日期 | 作者 | 变更说明 |
|-----|------|-----|---------|
| v1.0.0 | 2026-06-15 | AI-Tester | 初始版本，首次生成 |
