import "dotenv/config";
import path from "node:path";
import { execSync } from "node:child_process";
import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import type { RobotTextMessage, DWClientDownStream } from "dingtalk-stream";
import { loadConfig } from "./config.js";
import { OpenCodeClient } from "./opencode.js";
import { DingTalkClient } from "./dingtalk.js";
import { SessionStore } from "./session-store.js";
import { MessageQueue } from "./message-queue.js";
import { Logger } from "./logger.js";
import { ProjectRegistry, type ProjectConfig } from "./project-registry.js";
import { ProjectContextStore } from "./project-context-store.js";
import { ServerManager } from "./server-manager.js";
import { processAIMessage } from "./ai-handler.js";
import type { AIMessageContext } from "./ai-handler.js";

// Re-export pure utility
export { buildReplyMessage } from "./ai-handler.js";
// Pre-bound sendProcessingError so callers don't need to pass dingtalk/config
import { sendProcessingError as rawSendProcessingError } from "./ai-handler.js";
export function sendProcessingError(
  webhook: string,
  watchdogState: string | undefined,
  err: unknown,
  sessionId: string | undefined,
  isTimeout: boolean,
): Promise<void> {
  return rawSendProcessingError(dingtalk, config, webhook, watchdogState, err, sessionId, isTimeout);
}

const config = loadConfig();
const log = new Logger("Server", config.logLevel as never);
const defaultOpencode = new OpenCodeClient(config);
const dingtalk = new DingTalkClient(config.dingtalkBotName);
const sessions = new SessionStore(`${config.dataDir}/session-map.json`);
const projectContexts = new ProjectContextStore(`${config.dataDir}/project-context.json`);
projectContexts.clearAll();
const projectRegistry = new ProjectRegistry(config.projectsConfigPath, config.allowedProjectRoots);
const serverManager = new ServerManager(config);
const queue = new MessageQueue();
const streamCheckIntervalMs = 60_000;

// Per-session state
const timeoutsPerSession = new Map<string, number>();
const messagesPerSession = new Map<string, number>();
const streamUnhealthyThresholdMs = 180_000;
let shuttingDown = false;
let lastStreamHealthyAt = Date.now();
let streamSupervisor: ReturnType<typeof setInterval> | undefined;

// Shared context for AI processing (injected rather than passed through call chain)
const aiContext: AIMessageContext = {
  opencode: defaultOpencode,
  dingtalk,
  config,
  sessions,
  messagesPerSession,
  timeoutsPerSession,
};

export function getSessionKey(msg: RobotTextMessage, projectId = "default"): string {
  return `${projectId}:${msg.conversationId}:${msg.senderStaffId || msg.senderId}`;
}

function getContextKey(msg: RobotTextMessage): string {
  return `${msg.conversationId}:${msg.senderStaffId || msg.senderId}`;
}

export function stripBotMention(text: string): string {
  return text.replace(new RegExp(`@${config.dingtalkBotName}\\s*`, "g"), "").trim();
}

// ── Project helpers ──

function isDefaultServerProject(project: ProjectConfig): boolean {
  return project.path === path.resolve(process.cwd());
}

function getDefaultServerPort(): string {
  try {
    const url = new URL(config.opencodeServerUrl);
    return url.port || (url.protocol === "https:" ? "443" : "80");
  } catch {
    return config.opencodeServerUrl;
  }
}

async function buildProjectListMessage(): Promise<string> {
  const projects = projectRegistry.list();
  const defaultHealthy = await defaultOpencode.health();
  const rows = [
    "| 编号 | 项目名称 | 状态 | 路径 |",
    "|------|----------|------|------|",
  ];

  for (const project of projects) {
    const { running, port } = await serverManager.checkProject(project.id);
    const status = running
      ? `运行中:${port}`
      : isDefaultServerProject(project) && defaultHealthy
        ? `运行中:${getDefaultServerPort()}`
        : "未启动";
    rows.push(`| ${project.id} | ${project.name} | ${status} | ${project.path} |`);
  }

  return rows.join("\n");
}

async function ensureProjectClient(project: ProjectConfig): Promise<OpenCodeClient> {
  if (isDefaultServerProject(project)) return defaultOpencode;

  const baseUrl = await serverManager.startProject(project);
  return baseUrl !== defaultOpencode["baseUrl"]
    ? new OpenCodeClient(config, baseUrl)
    : defaultOpencode;
}

// ── Project commands ──

async function handleProjectCommand(message: string, msg: RobotTextMessage): Promise<boolean> {
  const text = message.trim();
  const contextKey = getContextKey(msg);

  if (["项目列表", "获取所有项目"].includes(text)) {
    await dingtalk.sendMessage(msg.sessionWebhook, await buildProjectListMessage());
    return true;
  }

  if (text === "当前项目") {
    const projectId = projectContexts.get(contextKey);
    const project = projectId ? projectRegistry.find(projectId) : undefined;
    if (!project) {
      await dingtalk.sendTextMessage(msg.sessionWebhook, "当前未选择项目");
      return true;
    }

    const { running, port } = await serverManager.checkProject(project.id);
    const status = running
      ? `运行中:${port}`
      : isDefaultServerProject(project) && await defaultOpencode.health()
        ? `运行中:${getDefaultServerPort()}`
        : "未启动";
    await dingtalk.sendTextMessage(
      msg.sessionWebhook,
      `当前项目：${project.name}（${project.id}）\n${project.path}\n状态：${status}`
    );
    return true;
  }

  if (["重启服务", "重启项目服务"].includes(text)) {
    const projectId = projectContexts.get(contextKey);
    const project = projectId ? projectRegistry.find(projectId) : undefined;
    if (!project) {
      await dingtalk.sendTextMessage(msg.sessionWebhook, "当前未选择项目，请先切换项目");
      return true;
    }
    await dingtalk.sendTextMessage(msg.sessionWebhook, `正在重启服务：${project.name}...`);
    try {
      const scriptPath = path.join(project.path, "scripts", "restart_services.sh");
      if (require("node:fs").existsSync(scriptPath) === false) {
        await dingtalk.sendTextMessage(msg.sessionWebhook, `当前项目没有 restart_services.sh 脚本（${scriptPath}），不执行操作`);
        return true;
      }
      const result = execSync(`bash "${scriptPath}"`, {
        cwd: project.path,
        timeout: 15_000,
        shell: "/bin/bash",
      }).toString().trim();
      await dingtalk.sendTextMessage(
        msg.sessionWebhook,
        `✅ 服务重启完成：${project.name}\n\`\`\`\n${result}\n\`\`\``
      );
    } catch (err) {
      await dingtalk.sendTextMessage(
        msg.sessionWebhook,
        `❌ 重启失败：${err instanceof Error ? err.message : String(err)}`
      );
    }
    return true;
  }

  if (text === "重置项目") {
    projectContexts.delete(contextKey);
    await dingtalk.sendTextMessage(msg.sessionWebhook, "已重置项目，后续将使用默认 OpenCode 服务");
    return true;
  }

  const match = text.match(/^(切换项目|使用项目)\s+(.+)$/);
  if (!match) return false;

  const identifier = match[2].trim();
  const project = projectRegistry.find(identifier);
  if (!project) {
    await dingtalk.sendTextMessage(msg.sessionWebhook, `未找到项目：${identifier}\n请发送"项目列表"查看可用项目`);
    return true;
  }

  const currentProjectId = projectContexts.get(contextKey);
  await dingtalk.sendTextMessage(
    msg.sessionWebhook,
    currentProjectId === project.id
      ? `当前已在项目：${project.name}（${project.id}），正在确认服务状态...`
      : `正在启动/切换项目：${project.name}（${project.id}）...`
  );

  projectContexts.set(contextKey, project.id);
  try {
    const baseUrl = await serverManager.startProject(project);
    await dingtalk.sendTextMessage(
      msg.sessionWebhook,
      `${currentProjectId === project.id ? "当前已在项目" : "已切换到项目"}：${project.name}（${project.id}）\n路径：${project.path}\n服务：${baseUrl}`
    );
  } catch (err) {
    projectContexts.delete(contextKey);
    await dingtalk.sendTextMessage(msg.sessionWebhook, `项目启动失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
}

// ── Message router ──

export async function handleRobotMessage(raw: string): Promise<void> {
  let msg: RobotTextMessage;
  try {
    msg = JSON.parse(raw) as RobotTextMessage;
  } catch {
    log.warn("failed to parse robot message", { raw: raw.slice(0, 100) });
    return;
  }

  if (msg.msgtype !== "text" || !msg.text?.content) {
    log.debug("ignored non-text message", { msgtype: msg.msgtype });
    return;
  }

  const message = stripBotMention(msg.text.content);

  log.info("incoming message", {
    from: msg.senderNick,
    convId: msg.conversationId,
    msg: message.slice(0, 80),
  });

  if (!message) {
    log.debug("empty message after stripping mention");
    await dingtalk.sendTextMessage(
      msg.sessionWebhook,
      `你好 ${msg.senderNick} 👋\n\n我是 OpenCode AI 编程助手，请直接发送需求，我来帮你处理。例如：\n  • "项目列表"\n  • "切换项目 stock"\n  • "修复这个项目的登录 Bug"`
    );
    return;
  }

  // Project commands
  if (await handleProjectCommand(message, msg)) return;

  // AI message
  const contextKey = getContextKey(msg);
  const projectId = projectContexts.get(contextKey);
  const project = projectId ? projectRegistry.find(projectId) : undefined;

  if (config.projectSwitchRequired && !project) {
    await dingtalk.sendTextMessage(msg.sessionWebhook, "请先发送「项目列表」，再使用「切换项目 <编号>」选择项目");
    return;
  }

  const sessionKey = getSessionKey(msg, project?.id ?? "default");
  const queued = queue.isBusy(sessionKey);

  // Resolve the opencode client for the active project
  if (project) {
    try {
      aiContext.opencode = await ensureProjectClient(project);
    } catch (err) {
      projectContexts.delete(contextKey);
      await dingtalk.sendTextMessage(
        msg.sessionWebhook,
        `项目服务启动失败，已清除当前项目：${err instanceof Error ? err.message : String(err)}\n请发送"项目列表"确认状态后重新切换项目`
      );
      return;
    }
  } else if (!serverManager.isDefaultHealthy) {
    await dingtalk.sendTextMessage(
      msg.sessionWebhook,
      `❌ **OpenCode 服务暂不可用**\n\n后台正在尝试自动恢复，请稍后重试。`
    );
    return;
  }

  await dingtalk.sendTextMessage(
    msg.sessionWebhook,
    queued
      ? `⏳ 已收到消息，当前会话还有任务在处理中，本次请求已排队...\n\n> ${message.slice(0, 100)}${message.length > 100 ? "..." : ""}`
      : `⏳ 已收到消息，正在用 OpenCode AI 处理中...\n\n> ${message.slice(0, 100)}${message.length > 100 ? "..." : ""}\n\n请稍候，处理完成后会通知您。`
  );

  queue.enqueue(sessionKey, () => processAIMessage(aiContext, sessionKey, message, msg));
}

// ── Bootstrap ──

log.info("starting DingTalk Stream client", {
  appKey: config.dingtalkAppKey ? config.dingtalkAppKey.slice(0, 6) + "..." : "(not set)",
});

if (!config.dingtalkAppKey || !config.dingtalkAppSecret) {
  log.error("DINGTALK_APP_KEY and DINGTALK_APP_SECRET are required");
  process.exit(1);
}

const client = new DWClient({
  clientId: config.dingtalkAppKey,
  clientSecret: config.dingtalkAppSecret,
  debug: config.logLevel === "DEBUG",
  keepAlive: true,
});

client.registerCallbackListener(TOPIC_ROBOT, (downstream: DWClientDownStream) => {
  lastStreamHealthyAt = Date.now();
  client.socketCallBackResponse(downstream.headers.messageId, { status: "SUCCESS" });
  handleRobotMessage(downstream.data);
});

function isStreamHealthy(): boolean {
  return client.connected === true;
}

async function reconnectDingTalkStream(reason: string): Promise<void> {
  if (shuttingDown || client.reconnecting) return;
  log.warn("reconnecting DingTalk Stream", { reason });
  try {
    await client.connect();
    lastStreamHealthyAt = Date.now();
  } catch (err) {
    log.error("DingTalk Stream reconnect failed", { error: String(err) });
  }
}

export function startStreamSupervisor(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (shuttingDown) return;

    if (isStreamHealthy()) {
      lastStreamHealthyAt = Date.now();
      return;
    }

    const unhealthyMs = Date.now() - lastStreamHealthyAt;
    log.warn("DingTalk Stream unhealthy", {
      connected: client.connected,
      registered: client.registered,
      reconnecting: client.reconnecting,
      unhealthyMs,
    });

    if (unhealthyMs >= streamUnhealthyThresholdMs) {
      void reconnectDingTalkStream("supervisor detected unhealthy stream");
    }
  }, streamCheckIntervalMs);
}

try {
  await client.connect();
  lastStreamHealthyAt = Date.now();
  streamSupervisor = startStreamSupervisor();
  await serverManager.start();
  log.info("DingTalk Stream client started successfully");
} catch (err) {
  log.error("failed to connect DingTalk Stream", { error: String(err) });
  process.exit(1);
}

function shutdown(signal: string): void {
  shuttingDown = true;
  log.info(`received ${signal}, shutting down...`);
  if (streamSupervisor) clearInterval(streamSupervisor);
  serverManager.stop();
  client.disconnect();
  sessions.flush();
  projectContexts.flush();
  log.info("goodbye");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
