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
import { Watchdog } from "./watchdog.js";
import { ProjectRegistry, type ProjectConfig } from "./project-registry.js";
import { ProjectServerManager } from "./project-server-manager.js";
import { ProjectContextStore } from "./project-context-store.js";

const config = loadConfig();
const log = new Logger("Server", config.logLevel as never);
const defaultOpencode = new OpenCodeClient(config);
const dingtalk = new DingTalkClient(config.dingtalkBotName);
const sessions = new SessionStore(`${config.dataDir}/session-map.json`);
const projectContexts = new ProjectContextStore(`${config.dataDir}/project-context.json`);
projectContexts.clearAll();
const projectRegistry = new ProjectRegistry(config.projectsConfigPath, config.allowedProjectRoots);
const projectServers = new ProjectServerManager(config);
const projectClients = new Map<string, OpenCodeClient>();
const queue = new MessageQueue();
const streamCheckIntervalMs = 60_000;

/** 每个会话的连续超时次数，用于检测上下文撑爆 */
const timeoutsPerSession = new Map<string, number>();
const streamUnhealthyThresholdMs = 180_000;
let shuttingDown = false;
let lastStreamHealthyAt = Date.now();
let streamSupervisor: ReturnType<typeof setInterval> | undefined;

export function getSessionKey(msg: RobotTextMessage, projectId = "default"): string {
  return `${projectId}:${msg.conversationId}:${msg.senderStaffId || msg.senderId}`;
}

function getContextKey(msg: RobotTextMessage): string {
  return `${msg.conversationId}:${msg.senderStaffId || msg.senderId}`;
}

export function stripBotMention(text: string): string {
  return text.replace(new RegExp(`@${config.dingtalkBotName}\\s*`, "g"), "").trim();
}

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
    const instance = await projectServers.getHealthy(project.id);
    const status = instance?.status === "running"
      ? `运行中:${instance.port}`
      : isDefaultServerProject(project) && defaultHealthy
        ? `运行中:${getDefaultServerPort()}`
        : "未启动";
    rows.push(`| ${project.id} | ${project.name} | ${status} | ${project.path} |`);
  }

  return rows.join("\n");
}

async function ensureProjectBaseUrl(project: ProjectConfig): Promise<string> {
  if (isDefaultServerProject(project)) return config.opencodeServerUrl;
  return (await projectServers.ensureStarted(project)).baseUrl;
}

async function ensureProjectClient(project: ProjectConfig): Promise<OpenCodeClient> {
  if (isDefaultServerProject(project)) return defaultOpencode;

  const baseUrl = await ensureProjectBaseUrl(project);
  const existing = projectClients.get(project.id);
  if (existing) return existing;
  const client = new OpenCodeClient(config, baseUrl);
  projectClients.set(project.id, client);
  return client;
}

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

    const instance = await projectServers.getHealthy(project.id);
    const status = instance?.status === "running"
      ? `运行中:${instance.port}`
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
    await dingtalk.sendTextMessage(msg.sessionWebhook, `未找到项目：${identifier}\n请发送“项目列表”查看可用项目`);
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
    const baseUrl = await ensureProjectBaseUrl(project);
    projectContexts.set(contextKey, project.id);
    await dingtalk.sendTextMessage(
      msg.sessionWebhook,
      `${currentProjectId === project.id ? "当前已在项目" : "已切换到项目"}：${project.name}（${project.id}）\n路径：${project.path}\n服务：${baseUrl}`
    );
  } catch (err) {
    await dingtalk.sendTextMessage(msg.sessionWebhook, `项目启动失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
}

export function buildReplyMessage(
  summary: string,
  changedFiles: string[],
  toolNames: string[],
  fullLength: number,
  shareUrl: string | null,
  sessionId: string,
): string {
  const parts: string[] = ["**✅ 任务完成**", ""];

  if (summary && summary !== "(无文本回复)") {
    parts.push(`📝 **处理摘要**：\n${summary}`);
    parts.push("");
  }

  if (changedFiles.length > 0) {
    parts.push(`📁 **修改文件**（${changedFiles.length} 个）：`);
    changedFiles.forEach((f) => parts.push(`  - \`${f}\``));
    parts.push("");
  }

  if (toolNames.length > 0) {
    parts.push(`🔧 **使用操作**：\`${toolNames.join("`, `")}\``);
    parts.push("");
  }

  if (fullLength > 0) {
    parts.push(`📏 回复总长度：${fullLength} 字符`);
  }

  if (shareUrl) {
    parts.push(`🔗 [查看完整对话](${shareUrl})`);
  } else {
    parts.push(`💬 会话ID: \`${sessionId.slice(0, 8)}\``);
  }

  return parts.join("\n");
}

export async function sendProcessingError(
  webhook: string,
  watchdogState: string | undefined,
  err: unknown,
  sessionId: string | undefined,
  isTimeout: boolean,
): Promise<void> {
  const errorMsg = err instanceof Error ? err.message : String(err);

  if (watchdogState === "server_down") {
    log.error("processing failed: server down", { error: errorMsg });
    await dingtalk.sendTextMessage(
      webhook,
      `❌ **处理失败**\n\n原因：OpenCode 服务不可用，请稍后重试\n${sessionId ? `\n💬 会话ID: \`${sessionId.slice(0, 8)}\`` : ""}`
    ).catch(() => {});
  } else if (isTimeout) {
    log.error("processing failed", { error: errorMsg, isTimeout: true });
    await dingtalk.sendTextMessage(
      webhook,
      `⚠️ **任务超时**\n\nOpenCode AI 处理时间超过 ${Math.round(config.requestTimeoutMs / 1000)} 秒，可能因为任务较复杂。\n\n建议：\n  1. 请发送 **更具体的需求**，分步执行\n  2. 可尝试重新发送当前需求\n${sessionId ? `\n💬 会话ID: \`${sessionId.slice(0, 8)}\`` : ""}`
    ).catch(() => {});
  } else if (err instanceof TypeError && errorMsg === "fetch failed") {
    log.error("processing failed: network error", { error: errorMsg });
    await dingtalk.sendTextMessage(
      webhook,
      `❌ **网络连接失败**\n\n无法连接到 OpenCode 服务（${config.opencodeServerUrl}），请检查：\n  1. OpenCode 服务是否正在运行\n  2. 网络是否通畅\n  3. 稍后重试\n${sessionId ? `\n💬 会话ID: \`${sessionId.slice(0, 8)}\`` : ""}`
    ).catch(() => {});
  } else {
    log.error("processing failed", { error: errorMsg, isTimeout: false });
    await dingtalk.sendTextMessage(
      webhook,
      `❌ **处理失败**\n\n原因：${errorMsg}\n\n建议：\n  1. 重新发送您的需求重试\n  2. 如果持续失败，请联系管理员\n${sessionId ? `\n💬 会话ID: \`${sessionId.slice(0, 8)}\`` : ""}`
    ).catch(() => {});
  }
}

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

  if (await handleProjectCommand(message, msg)) return;

  const contextKey = getContextKey(msg);
  const projectId = projectContexts.get(contextKey);
  const project = projectId ? projectRegistry.find(projectId) : undefined;

  if (config.projectSwitchRequired && !project) {
    await dingtalk.sendTextMessage(msg.sessionWebhook, "请先发送“项目列表”，再使用“切换项目 <编号>”选择项目");
    return;
  }

  const activeProjectId = project?.id ?? "default";
  const sessionKey = getSessionKey(msg, activeProjectId);
  const queued = queue.isBusy(sessionKey);
  let activeOpencode = defaultOpencode;

  if (project) {
    try {
      activeOpencode = await ensureProjectClient(project);
    } catch (err) {
      projectContexts.delete(contextKey);
      await dingtalk.sendTextMessage(
        msg.sessionWebhook,
        `项目服务启动失败，已清除当前项目：${err instanceof Error ? err.message : String(err)}\n请发送“项目列表”确认状态后重新切换项目`
      );
      return;
    }
  }

  await dingtalk.sendTextMessage(
    msg.sessionWebhook,
    queued
      ? `⏳ 已收到消息，当前会话还有任务在处理中，本次请求已排队...\n\n> ${message.slice(0, 100)}${message.length > 100 ? "..." : ""}`
      : `⏳ 已收到消息，正在用 OpenCode AI 处理中...\n\n> ${message.slice(0, 100)}${message.length > 100 ? "..." : ""}\n\n请稍候，处理完成后会通知您。`
  );

  queue.enqueue(sessionKey, async () => {
    const opencode = activeOpencode;
    let sessionId: string | undefined;
    let heartbeatCount = 0;
    const heartbeat = setInterval(async () => {
      heartbeatCount++;
      try {
        await dingtalk.sendTextMessage(
          msg.sessionWebhook,
          `⏳ 任务仍在处理中，已等待 ${heartbeatCount * 60} 秒... ${heartbeatCount >= 3 ? "复杂任务可能需要更长时间，请耐心等待" : ""}`
        );
      } catch {
        // webhook may expire after long idle; ignore heartbeat errors
      }
    }, 60_000);

    // Watchdog retry loop
    // If the watchdog detects a session has vanished mid-stream,
    // we create a new session and retry once.
    let currentSessionId: string | undefined;
    let retries = 0;
    const maxRetries = 1;
    let shouldRetry = false;

    do {
      shouldRetry = false;
      const abortController = new AbortController();
      let watchdog: Watchdog | undefined;

      try {
        currentSessionId = sessions.get(sessionKey);

        if (!currentSessionId) {
          log.info("creating opencode session", { sessionKey });
          const session = await opencode.createSession(`钉钉-${msg.senderNick}`);
          currentSessionId = session.id;
          sessions.set(sessionKey, currentSessionId);
        }
        sessionId = currentSessionId;

        log.info("sending to opencode", {
          sessionId: sessionId.slice(0, 8),
          message: message.slice(0, 60),
        });

        // Start watchdog: monitors server health and session existence
        // It will abort `abortController` if it detects a problem.
        watchdog = new Watchdog(opencode, currentSessionId, abortController);
        watchdog.start();

        const response = await opencode.sendMessage(currentSessionId, message, abortController.signal);
        watchdog.stop();
        clearInterval(heartbeat);

        const { summary, changedFiles, toolNames, fullLength } = opencode.extractSummary(response);

        const shareUrl = await opencode.shareSession(sessionId);

        const dingtalkReply = buildReplyMessage(summary, changedFiles, toolNames, fullLength, shareUrl, sessionId);

        log.info("sending summary reply to DingTalk", {
          summaryLen: summary.length,
          fileCount: changedFiles.length,
          sessionId: sessionId.slice(0, 8),
        });

        try {
          await dingtalk.sendMessage(msg.sessionWebhook, dingtalkReply);
        } catch (sendErr) {
          log.error("DingTalk reply failed after processing succeeded", {
            error: String(sendErr),
            sessionId: sessionId.slice(0, 8),
          });
          await dingtalk.sendTextMessage(
            msg.sessionWebhook,
            `⚠️ **任务已完成，但结果发送失败**\n\n原因：${sendErr instanceof Error ? sendErr.message : String(sendErr)}\n\n💬 会话ID: \`${sessionId.slice(0, 8)}\``
          ).catch(() => {});
        }
      } catch (err) {
        if (watchdog) watchdog.stop();

        const isNetworkError = err instanceof TypeError && err.message === "fetch failed";
        if (isNetworkError && retries < maxRetries) {
          retries++;
          shouldRetry = true;

          log.warn("retrying with new session after network error", {
            attempt: retries,
            oldSessionId: currentSessionId?.slice(0, 8),
            sessionKey,
          });

          try {
            const newSession = await opencode.createSession(`钉钉-${msg.senderNick}-${Date.now()}`);
            currentSessionId = newSession.id;
            sessions.set(sessionKey, currentSessionId);
            await dingtalk.sendTextMessage(
              msg.sessionWebhook,
              `⏳ OpenCode 连接中断，已切换新会话重试（第 ${retries} 次）...`
            ).catch(() => {});
          } catch (retryErr) {
            log.error("retry session creation failed", { error: String(retryErr) });
            shouldRetry = false;
            clearInterval(heartbeat);
            await sendProcessingError(msg.sessionWebhook, watchdog?.state, retryErr, sessionId, false);
          }

          continue;
        }

        // Watchdog detected session vanished → create new session and retry
        if (watchdog?.state === "restart" && retries < maxRetries) {
          retries++;
          shouldRetry = true;

          log.warn("restarting session after watchdog detection", {
            attempt: retries,
            oldSessionId: currentSessionId?.slice(0, 8),
          });

          try {
            const newSession = await opencode.createSession(`钉钉-${msg.senderNick}`);
            currentSessionId = newSession.id;
            sessions.set(sessionKey, currentSessionId);

            await dingtalk.sendTextMessage(
              msg.sessionWebhook,
              `⏳ 检测到任务异常，正在重新处理（第 ${retries} 次重试）...`
            ).catch(() => {});
          } catch (retryErr) {
            log.error("retry session creation failed", { error: String(retryErr) });
            shouldRetry = false;
            clearInterval(heartbeat);
            await sendProcessingError(msg.sessionWebhook, watchdog?.state, retryErr, sessionId, false);
          }

          continue;
        }

        // Context overload: consecutive timeouts mean session context is bloated
        // → invalidate stale session so next request starts fresh
        const isTimeout = err instanceof Error && err.name === "AbortError";
        if (isTimeout) {
          const prev = timeoutsPerSession.get(sessionKey) ?? 0;
          timeoutsPerSession.set(sessionKey, prev + 1);
          if (prev + 1 >= 2 && retries < maxRetries) {
            retries++;
            shouldRetry = true;
            timeoutsPerSession.set(sessionKey, 0);
            sessions.delete(sessionKey);

            log.warn("context overload detected, starting new session", {
              attempt: retries,
              oldSessionId: currentSessionId?.slice(0, 8),
              sessionKey,
            });

            try {
              const newSession = await opencode.createSession(`钉钉-${msg.senderNick}`);
              currentSessionId = newSession.id;
              sessions.set(sessionKey, currentSessionId);

              await dingtalk.sendTextMessage(
                msg.sessionWebhook,
                `⏳ 上下文已满，已切换新会话继续处理（第 ${retries} 次重试）...`
              ).catch(() => {});
            } catch (retryErr) {
              log.error("retry session creation failed", { error: String(retryErr) });
              shouldRetry = false;
              clearInterval(heartbeat);
              await sendProcessingError(msg.sessionWebhook, watchdog?.state, retryErr, sessionId, false);
            }

            continue;
          }
        } else {
          timeoutsPerSession.set(sessionKey, 0);
        }

        clearInterval(heartbeat);
        await sendProcessingError(msg.sessionWebhook, watchdog?.state, err, sessionId, isTimeout);
      }
    } while (shouldRetry);
  });
}

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
  log.info("DingTalk Stream client started successfully");
} catch (err) {
  log.error("failed to connect DingTalk Stream", { error: String(err) });
  process.exit(1);
}

function shutdown(signal: string): void {
  shuttingDown = true;
  log.info(`received ${signal}, shutting down...`);
  if (streamSupervisor) clearInterval(streamSupervisor);
  client.disconnect();
  if (signal === "SIGINT") projectServers.stopAll();
  sessions.flush();
  projectContexts.flush();
  log.info("goodbye");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
