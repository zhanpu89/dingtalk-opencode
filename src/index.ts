import "dotenv/config";
import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import type { RobotTextMessage, DWClientDownStream } from "dingtalk-stream";
import { loadConfig } from "./config.js";
import { OpenCodeClient } from "./opencode.js";
import { DingTalkClient } from "./dingtalk.js";
import { SessionStore } from "./session-store.js";
import { MessageQueue } from "./message-queue.js";
import { Logger } from "./logger.js";

const config = loadConfig();
const log = new Logger("Server", config.logLevel as never);
const opencode = new OpenCodeClient(config);
const dingtalk = new DingTalkClient(config.dingtalkBotName);
const sessions = new SessionStore(`${config.dataDir}/session-map.json`);
const queue = new MessageQueue();

function getSessionKey(msg: RobotTextMessage): string {
  return `${msg.conversationId}:${msg.senderId}`;
}

function stripBotMention(text: string): string {
  return text.replace(new RegExp(`@${config.dingtalkBotName}\\s*`, "g"), "").trim();
}

async function handleRobotMessage(raw: string): Promise<void> {
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

    try {
      sessionId = sessions.get(sessionKey);

      if (!sessionId) {
        log.info("creating opencode session", { sessionKey });
        const session = await opencode.createSession(`钉钉-${msg.senderNick}`);
        sessionId = session.id;
        sessions.set(sessionKey, sessionId);
      }

      log.info("sending to opencode", {
        sessionId: sessionId.slice(0, 8),
        message: message.slice(0, 60),
      });

      const response = await opencode.sendMessage(sessionId, message);
      clearInterval(heartbeat);

      const { summary, changedFiles, toolNames, fullLength } = opencode.extractSummary(response);

      const shareUrl = await opencode.shareSession(sessionId);

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

      const dingtalkReply = parts.join("\n");

      log.info("sending summary reply to DingTalk", {
        summaryLen: summary.length,
        fileCount: changedFiles.length,
        sessionId: sessionId.slice(0, 8),
      });

      await dingtalk.sendMessage(msg.sessionWebhook, dingtalkReply);
    } catch (err) {
      clearInterval(heartbeat);
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isTimeout = err instanceof Error && err.name === "AbortError";
      log.error("processing failed", { error: errorMsg, isTimeout });

      if (isTimeout) {
        await dingtalk.sendTextMessage(
          msg.sessionWebhook,
          `⚠️ **任务超时**\n\nOpenCode AI 处理时间超过 ${Math.round(config.requestTimeoutMs / 1000)} 秒，可能因为任务较复杂。\n\n建议：\n  1. 请发送 **更具体的需求**，分步执行\n  2. 可尝试重新发送当前需求\n${sessionId ? `\n💬 会话ID: \`${sessionId.slice(0, 8)}\`` : ""}`
        );
      } else {
        await dingtalk.sendTextMessage(
          msg.sessionWebhook,
          `❌ **处理失败**\n\n原因：${errorMsg}\n\n建议：\n  1. 重新发送您的需求重试\n  2. 如果持续失败，请联系管理员\n${sessionId ? `\n💬 会话ID: \`${sessionId.slice(0, 8)}\`` : ""}`
        );
      }
    }
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
