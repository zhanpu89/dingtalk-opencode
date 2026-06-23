import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
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
const projectRegistry = new ProjectRegistry(config.projectsConfigPath, config.allowedProjectRoots);
const serverManager = new ServerManager(config);
const queue = new MessageQueue();

let shuttingDown = false;

// ── 全局限流器 (MSG-REG-11) ──
class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(private maxTokens: number, private windowMs: number) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  tryConsume(): boolean {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    // Refill tokens based on elapsed time
    this.tokens = Math.min(this.maxTokens, this.tokens + (elapsed / this.windowMs) * this.maxTokens);
    this.lastRefill = now;

    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const rateLimiter = new RateLimiter(config.rateLimitMax, config.rateLimitWindowMs);

/**
 * 每个任务创建独立的 AIMessageContext，避免 aiContext.opencode 共享可变状态
 * 导致的消息间污染（用户A切换项目后，用户B的请求可能拿到错误 client）。
 */
function buildTaskContext(opencodeClient: OpenCodeClient): AIMessageContext {
  return { opencode: opencodeClient, dingtalk, config, sessions };
}

export function getSessionKey(msg: RobotTextMessage, projectId = "default"): string {
  return `${projectId}:${msg.conversationId}:${msg.senderId}`;
}

function getContextKey(msg: RobotTextMessage): string {
  return `${msg.conversationId}:${msg.senderId}`;
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

// ── Project commands ──

async function handleProjectCommand(message: string, msg: RobotTextMessage): Promise<boolean> {
  const text = message.trim();
  const contextKey = getContextKey(msg);

  if (["项目列表", "获取所有项目"].includes(text)) {
    await dingtalk.sendMessage(msg.sessionWebhook, { title: "项目列表", text: await buildProjectListMessage() });
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

  if (["强制重启", "暴力重启"].includes(text)) {
    try {
      await dingtalk.sendTextMessage(msg.sessionWebhook, "正在强制重启机器人服务...");
      serverManager.stopAllProjects();
      sessions.flush();

      // 写标记文件：新实例启动后将通过此文件推送重启成功通知
      const notifyFile = path.join(config.dataDir, ".restart-notify");
      try {
        fs.mkdirSync(path.dirname(notifyFile), { recursive: true });
        fs.writeFileSync(notifyFile, msg.sessionWebhook, "utf-8");
      } catch { /* 通知非关键，失败不影响重启 */ }

      const scriptPath = path.join(process.cwd(), "scripts", "restart_bot.sh");
      if (!fs.existsSync(scriptPath)) {
        await dingtalk.sendTextMessage(msg.sessionWebhook, `重启脚本不存在（${scriptPath}），请手动执行：npm run start:all`);
        return true;
      }
      const child = spawn("bash", [scriptPath], {
        cwd: process.cwd(),
        stdio: "ignore",
        detached: true,
      });
      child.unref();

      log.info("restart script spawned, sending confirmation", { pid: child.pid });
      await dingtalk.sendTextMessage(msg.sessionWebhook, "✅ 机器人服务正在重启，请稍候...");
      log.info("restart confirmation sent, exiting in 2s");
      setTimeout(() => process.exit(0), 2000);
    } catch (err) {
      log.error("force restart failed", { error: String(err) });
      await dingtalk.sendTextMessage(
        msg.sessionWebhook,
        `❌ 重启失败：${err instanceof Error ? err.message : String(err)}`
      ).catch(() => {});
    }
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

  try {
    // 默认项目（路径等于 project root）复用已有 4096 服务，避免起新端口
    const baseUrl = isDefaultServerProject(project)
      ? defaultOpencode.baseUrl
      : await serverManager.startProject(project);
    // 只在服务启动成功后设置上下文，避免异步操作期间上下文被清除
    projectContexts.set(contextKey, project.id);
    await dingtalk.sendTextMessage(
      msg.sessionWebhook,
      `${currentProjectId === project.id ? "当前已在项目" : "已切换到项目"}：${project.name}（${project.id}）\n路径：${project.path}\n服务：${baseUrl}`
    );
  } catch (err) {
    // 上下文从未设置过（失败路径不会 set），无需清理
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

  // MSG-REG-11: 全局限流
  if (!rateLimiter.tryConsume()) {
    await dingtalk.sendTextMessage(msg.sessionWebhook, "系统繁忙，请稍后再试");
    return;
  }

  const sessionKey = getSessionKey(msg, project?.id ?? "default");
  const queued = queue.isBusy(sessionKey);

  // 为每个任务解析独立的 OpenCode client，不再修改共享的 aiContext 对象
  let opencodeForTask: OpenCodeClient;
  if (project) {
    try {
      if (isDefaultServerProject(project)) {
        opencodeForTask = defaultOpencode;
      } else {
        const baseUrl = await serverManager.startProject(project);
        opencodeForTask = baseUrl !== defaultOpencode.baseUrl
          ? new OpenCodeClient(config, baseUrl)
          : defaultOpencode;
      }
    } catch (err) {
      // 只报错不移除上下文，避免 AI 任务失败影响用户已选的项目
      await dingtalk.sendTextMessage(
        msg.sessionWebhook,
        `项目服务启动失败：${err instanceof Error ? err.message : String(err)}\n请发送"项目列表"确认状态后重新切换项目`
      );
      return;
    }
  } else {
    if (!serverManager.isDefaultHealthy) {
      await dingtalk.sendTextMessage(
        msg.sessionWebhook,
        `❌ **OpenCode 服务暂不可用**\n\n后台正在尝试自动恢复，请稍后重试。`
      );
      return;
    }
    opencodeForTask = defaultOpencode;
  }

  await dingtalk.sendTextMessage(
    msg.sessionWebhook,
    queued
      ? `⏳ 已收到消息，当前会话还有任务在处理中，本次请求已排队...\n\n> ${message.slice(0, 100)}${message.length > 100 ? "..." : ""}`
      : `⏳ 已收到消息，正在用 OpenCode AI 处理中...\n\n> ${message.slice(0, 100)}${message.length > 100 ? "..." : ""}\n\n请稍候，处理完成后会通知您。`
  );

  // 每个任务使用独立的 context，避免 opencode client 被后续消息覆盖
  const taskContext = buildTaskContext(opencodeForTask);
  queue.enqueue(sessionKey, () => processAIMessage(taskContext, sessionKey, message, msg));
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
  client.socketCallBackResponse(downstream.headers.messageId, { status: "SUCCESS" });
  handleRobotMessage(downstream.data);
});

try {
  await client.connect();
  await serverManager.start();
  log.info("DingTalk Stream client started successfully");

  // ── 重启成功通知 ──
  // 检查是否有重启标记文件（暴力重启写入），若有则推送通知并清理
  const notifyFile = path.join(config.dataDir, ".restart-notify");
  if (fs.existsSync(notifyFile)) {
    const webhook = fs.readFileSync(notifyFile, "utf-8").trim();
    fs.unlinkSync(notifyFile);
    if (webhook) {
      log.info("sending restart success notification");
      fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          msgtype: "markdown",
          markdown: {
            title: "重启完成",
            text: "✅ **机器人已重新启动**\n\n服务已成功重启，准备就绪！",
          },
        }),
      }).then((res) => {
        if (res.ok) log.info("restart notification sent");
        else log.warn("restart notification failed", { status: res.status });
      }).catch((err) => {
        log.warn("restart notification send error", { error: String(err) });
      });
    }
  }
} catch (err) {
  log.error("failed to connect DingTalk Stream", { error: String(err) });
  process.exit(1);
}

function shutdown(signal: string): void {
  shuttingDown = true;
  log.info(`received ${signal}, shutting down...`);
  serverManager.stop();
  client.disconnect();
  sessions.flush();
  log.info("goodbye");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
