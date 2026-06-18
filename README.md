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

编辑 `projects.json`，并在 `.env` 中配置允许的项目根目录：

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

`start:all` 会同时启动 opencode API 服务和钉钉机器人。

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

## 配置说明

| 环境变量 | 必填 | 默认值 | 说明 |
|---------|------|--------|------|
| `DINGTALK_APP_KEY` | 是 | - | 钉钉应用 AppKey |
| `DINGTALK_APP_SECRET` | 是 | - | 钉钉应用 AppSecret |
| `DINGTALK_BOT_NAME` | 否 | `OpenCode` | 钉钉机器人名称 |
| `OPENCODE_SERVER_URL` | 否 | `http://localhost:4096` | opencode 服务地址 |
| `OPENCODE_SERVER_PASSWORD` | 否 | - | opencode 密码 |
| `REQUEST_TIMEOUT_MS` | 否 | `1800000` | 流式空闲超时(毫秒) |
| `LOG_LEVEL` | 否 | `INFO` | 日志级别：DEBUG/INFO/WARN/ERROR |
| `DATA_DIR` | 否 | `data` | 数据目录 |
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
| `强制重启` / `暴力重启` | 停止所有服务并重启机器人 |

切换项目后，普通消息会发送到该项目目录下启动的 `opencode serve`。如项目服务未启动，机器人会自动在项目目录中启动并等待健康检查通过。

> ⚠️ **常见问题：项目消息卡住不回复**
>
> 如果切换到项目后发送消息一直显示"正在处理中"最终超时，通常是项目的 `opencode.json` 权限配置导致。
>
> 项目的 `opencode.json` 中如果设置了 `"permission": { "bash": { "*": "ask" } }`，当 AI 需要执行非白名单命令时会弹交互式授权确认框。但 `opencode serve` 运行在无交互的 headless 模式下，弹框无人应答 → **请求永久挂起**。
>
> **解决方案**：将项目 `opencode.json` 中的 `"*": "ask"` 改为 `"*": "allow"`，或直接在根级别设：
>
> ```json
> "permission": {
>     "edit": "allow",
>     "bash": "allow"
> }
> ```
>
> 如果项目需要细粒度控制，可以为常用命令单独放行（如 `"git *": "allow"`），但确保无 `"*": "ask"`。

## 测试

```bash
npm test
npm run test:watch
```

测试框架使用 [vitest](https://vitest.dev)，测试文件位于 `src/test/`。

## 项目结构

```
src/
├── index.ts                   # 入口：连接钉钉 Stream，消息分发
├── config.ts                  # 环境变量加载
├── ai-handler.ts              # AI 消息处理（重试/心跳/看门狗）
├── opencode.ts                # opencode API 客户端（SSE 流式）
├── dingtalk.ts                # 钉钉消息发送
├── message-queue.ts           # 每个用户/项目的消息队列
├── session-store.ts           # 钉钉用户 ↔ opencode session 映射
├── project-registry.ts        # 多项目配置加载与查询
├── project-context-store.ts   # 钉钉会话 ↔ 当前项目映射
├── server-manager.ts          # 动态项目 opencode 服务管理
├── watchdog.ts                # 服务健康检查与 session 存活检测（仅监控不中断消息）
├── types.ts                   # TypeScript 类型定义
├── logger.ts                  # 日志工具
└── test/                      # 测试
    ├── session-store.spec.ts
    ├── opencode.spec.ts
    ├── project-registry.spec.ts
    ├── server-manager.spec.ts
    ├── ai-handler.spec.ts
    ├── watchdog.spec.ts
    ├── dingtalk.spec.ts
    └── config.spec.ts
doc/
├── detailed/                  # 详细设计文档
└── tester/                    # 测试用例与测试报告
```
