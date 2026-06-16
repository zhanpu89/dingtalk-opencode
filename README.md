# dingtalk-opencode

钉钉机器人中间件，将钉钉消息转发给 [opencode](https://opencode.ai) AI 编程助手，并将处理结果回复到钉钉会话。

## 工作原理

```
用户发消息 → 钉钉机器人(Stream模式) → opencode API → 处理完成 → 回复钉钉
```

- 使用钉钉 Stream 模式（WebSocket），无需公网 IP 或端口映射
- 使用 opencode SSE 流式 API，长时间任务不超时
- 自动为每个钉钉用户维护 opencode 会话（session），支持连续对话
- 同一用户的多个请求按顺序排队处理
- 支持预配置多项目，通过钉钉指令切换项目并动态启动项目级 opencode 服务

## 前置要求

- [Node.js](https://nodejs.org/) >= 18
- [opencode](https://opencode.ai) CLI 已安装并登录

## 快速开始

### 1. 创建钉钉企业内部应用

1. 打开 [钉钉开放平台](https://open-dev.dingtalk.com)
2. **应用开发 → 企业内部应用 → 创建应用**
3. 在应用详情页获取 **AppKey** 和 **AppSecret**
4. **应用功能 → 机器人 → 启用机器人**
5. 消息接收模式选择 **Stream 模式**

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，填入必填项：

```ini
DINGTALK_APP_KEY=你的AppKey
DINGTALK_APP_SECRET=你的AppSecret
OPENCODE_SERVER_PASSWORD=你的opencode密码（如已设置）
```

### 4. 配置多项目（可选）

如需在钉钉中切换多个代码项目：

```bash
cp projects.example.json projects.json
```

编辑 `projects.json`：

```json
{
  "projects": [
    {
      "id": "bot",
      "name": "钉钉机器人",
      "path": "/root/project/dingtalk-opencode"
    }
  ]
}
```

并在 `.env` 中配置允许的项目根目录：

```ini
PROJECTS_CONFIG_PATH=projects.json
ALLOWED_PROJECT_ROOTS=/root/project
PROJECT_SWITCH_REQUIRED=false
```

### 5. 构建并启动

```bash
npm run build
npm run start:all
```

`start:all` 会同时启动：

- `opencode serve --port 4096` — opencode API 服务
- `tsx watch src/index.ts` — 钉钉机器人（文件变更自动重启）

也可以分两个终端运行：

```bash
# 终端 1：启动 opencode 服务
opencode serve --port 4096

# 终端 2：启动钉钉机器人
npm run dev
```

### 使用 Docker

```bash
npm run docker:build
npm run docker:run
```

## 关键说明

### 权限配置（`opencode.json`）

opencode 在 headless/server 模式下，`external_directory` 和 `doom_loop` 两个权限默认会弹交互式确认框，但由于没有 UI，请求会永久挂起直到超时。

项目根目录下的 [`opencode.json`](./opencode.json) 已将这些权限设为 `"allow"`，避免卡住：

```json
{
  "permission": {
    "*": "allow",
    "doom_loop": "allow",
    "external_directory": "allow"
  }
}
```

如需更严格的限制，可按 [opencode 权限文档](https://opencode.ai/docs/permissions/) 调整。

## 配置说明

| 环境变量 | 必填 | 默认值 | 说明 |
|---------|------|--------|------|
| `DINGTALK_APP_KEY` | 是 | - | 钉钉应用 AppKey |
| `DINGTALK_APP_SECRET` | 是 | - | 钉钉应用 AppSecret |
| `DINGTALK_BOT_NAME` | 否 | `OpenCode` | 钉钉机器人名称 |
| `OPENCODE_SERVER_URL` | 否 | `http://localhost:4096` | opencode 服务地址 |
| `OPENCODE_SERVER_PASSWORD` | 否 | - | opencode 密码 |
| `REQUEST_TIMEOUT_MS` | 否 | `1800000` | 流式空闲超时(毫秒)，两个数据块之间超过此时间即断开，不会限制总处理时长 |
| `LOG_LEVEL` | 否 | `INFO` | 日志级别：DEBUG/INFO/WARN/ERROR |
| `LOG_FILE` | 否 | `data/app.log` | 日志文件路径 |
| `DATA_DIR` | 否 | `data` | session 映射文件目录 |
| `PROJECTS_CONFIG_PATH` | 否 | `projects.json` | 多项目配置文件路径 |
| `ALLOWED_PROJECT_ROOTS` | 否 | - | 允许启动的项目根目录，多个用逗号分隔 |
| `PROJECT_SERVER_PORT_START` | 否 | `4100` | 动态项目 opencode 服务起始端口 |
| `PROJECT_SERVER_HOSTNAME` | 否 | `127.0.0.1` | 动态项目 opencode 服务监听地址 |
| `PROJECT_SERVER_IDLE_MS` | 否 | `7200000` | 项目服务空闲回收时间 |
| `PROJECT_SWITCH_REQUIRED` | 否 | `false` | 是否要求先选择项目再处理普通消息 |

## 钉钉项目指令

| 指令 | 说明 |
|------|------|
| `项目列表` / `获取所有项目` | 查看所有预配置项目及状态 |
| `切换项目 <编号或名称>` | 切换当前会话使用的项目 |
| `使用项目 <编号或名称>` | 同上 |
| `当前项目` | 查看当前会话绑定的项目 |
| `重置项目` | 清除当前会话的项目绑定 |

切换项目后，普通消息会发送到该项目目录下启动的 `opencode serve`。如项目服务未启动，机器人会自动在项目目录中启动并等待健康检查通过。

## 测试

```bash
# 运行全部测试
npm test

# 监听模式
npm run test:watch
```

测试框架使用 [vitest](https://vitest.dev)（Jest 兼容 API），测试文件位于 `src/test/`。

## 项目结构

```
src/
├── index.ts          # 入口：连接钉钉 Stream，消息分发
├── config.ts         # 环境变量加载
├── opencode.ts              # opencode API 客户端（SSE 流式）
├── dingtalk.ts              # 钉钉消息发送
├── message-queue.ts         # 每个用户/项目的消息队列
├── session-store.ts         # 钉钉用户 ↔ opencode session 映射
├── project-registry.ts      # 多项目配置加载与查询
├── project-context-store.ts # 钉钉会话 ↔ 当前项目映射
├── project-server-manager.ts # 动态项目 opencode 服务管理
├── types.ts                 # TypeScript 类型定义
├── logger.ts                # 日志工具
└── test/                    # 单元测试与集成测试
    ├── dingtalk.spec.ts
    ├── message-queue.spec.ts
    ├── session-store.spec.ts
    ├── watchdog.spec.ts
    ├── opencode.spec.ts
    └── index.spec.ts
doc/
├── design.md         # 设计文档
└── tester/           # 测试用例与测试报告
    ├── *_测试用例.md
    └── dingtalk-opencode_测试报告.md
```

## 对话流程

1. 用户在钉钉群 @机器人 或私聊发送消息
2. 机器人立即回复「已收到消息，正在处理中...」
3. 机器人通过 SSE 流式 API 向 opencode 发送消息
4. opencode 处理完成后，机器人提取摘要和修改的文件列表
5. 机器人将结果和会话链接回复到钉钉
