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

### 4. 构建并启动

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
| `DATA_DIR` | 否 | `data` | session 映射文件目录 |

## 项目结构

```
src/
├── index.ts          # 入口：连接钉钉 Stream，消息分发
├── config.ts         # 环境变量加载
├── opencode.ts       # opencode API 客户端（SSE 流式）
├── dingtalk.ts       # 钉钉消息发送
├── message-queue.ts  # 每个用户的消息队列
├── session-store.ts  # 钉钉用户 ↔ opencode session 映射
├── types.ts          # TypeScript 类型定义
└── logger.ts         # 日志工具
```

## 对话流程

1. 用户在钉钉群 @机器人 或私聊发送消息
2. 机器人立即回复「已收到消息，正在处理中...」
3. 机器人通过 SSE 流式 API 向 opencode 发送消息
4. opencode 处理完成后，机器人提取摘要和修改的文件列表
5. 机器人将结果和会话链接回复到钉钉
