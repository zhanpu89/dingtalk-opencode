import "dotenv/config";
import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import type { RobotTextMessage, DWClientDownStream } from "dingtalk-stream";
import { loadConfig } from "./config.js";
import { OpenCodeClient } from "./opencode.js";
import { DingTalkClient } from "./dingtalk.js";
import { SessionStore } from "./session-store.js";
import { MessageQueue } from "./message-queue.js";
import { Logger } from "./logger.js";
import { Watchdog } from "./watchdog.js";

const config = loadConfig();
const log = new Logger("Server", config.logLevel as never);
const opencode = new OpenCodeClient(config);
const dingtalk = new DingTalkClient(config.dingtalkBotName);
const sessions = new SessionStore(`${config.dataDir}/session-map.json`);
const queue = new MessageQueue();

export function getSessionKey(msg: RobotTextMessage): string {
  return `${msg.conversationId}:${msg.senderId}`;
}

export function stripBotMention(text: string): string {
  return text.replace(new RegExp(`@${config.dingtalkBotName}\\s*`, "g"), "").trim();
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
      `你好 ${msg.senderNick} 👋\n\n我是 OpenCode AI 编程助手，请直接发送需求，我来帮你处理。例如：\n  • "帮我写一个 Python 脚本读取 CSV"\n  • "修复这个项目的登录 Bug"\n  • "给 User 模型添加 email 字段"`
    );
    return;
  }

  await dingtalk.sendTextMessage(
    msg.sessionWebhook,
    `⏳ 已收到消息，正在用 OpenCode AI 处理中...\n\n> ${message.slice(0, 100)}${message.length > 100 ? "..." : ""}\n\n请稍候，处理完成后会通知您。`
  );

  const sessionKey = getSessionKey(msg);

  queue.enqueue(sessionKey, async () => {
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

        clearInterval(heartbeat);
        const isTimeout = err instanceof Error && err.name === "AbortError";
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
});

client.registerCallbackListener(TOPIC_ROBOT, (downstream: DWClientDownStream) => {
  client.socketCallBackResponse(downstream.headers.messageId, { status: "SUCCESS" });
  handleRobotMessage(downstream.data);
});

client.on("connected", () => {
  log.info("DingTalk Stream connected");
});

client.on("disconnected", () => {
  log.warn("DingTalk Stream disconnected");
});

client.on("error", (err) => {
  log.error("DingTalk Stream error", { error: String(err) });
});

try {
  await client.connect();
  log.info("DingTalk Stream client started successfully");
} catch (err) {
  log.error("failed to connect DingTalk Stream", { error: String(err) });
  process.exit(1);
}

function shutdown(signal: string): void {
  log.info(`received ${signal}, shutting down...`);
  client.disconnect();
  sessions.flush();
  log.info("goodbye");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
