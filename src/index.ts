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
      `你好 ${msg.senderNick}，请直接发送需求，我来帮你用 OpenCode 处理。`
    );
    return;
  }

  const sessionKey = getSessionKey(msg);

  queue.enqueue(sessionKey, async () => {
    try {
      let sessionId = sessions.get(sessionKey);

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
      const { summary, changedFiles, fullLength } = opencode.extractSummary(response);

      const shareUrl = await opencode.shareSession(sessionId);

      let dingtalkReply: string;
      if (changedFiles.length > 0) {
        const fileList = changedFiles.map((f) => `  - \`${f}\``).join("\n");
        dingtalkReply = [
          `**✅ 任务完成**`,
          ``,
          `📝 ${summary}`,
          ``,
          `📁 修改文件：`,
          fileList,
        ].join("\n");
      } else {
        dingtalkReply = `**✅ 完成**\n\n${summary}`;
      }

      if (shareUrl) {
        dingtalkReply += `\n\n🔗 [查看完整对话](${shareUrl})`;
      } else {
        dingtalkReply += `\n\n💬 完整对话已保存 \`${sessionId.slice(0, 8)}\``;
      }

      log.info("sending summary reply to DingTalk", {
        summaryLen: summary.length,
        fileCount: changedFiles.length,
        sessionId: sessionId.slice(0, 8),
      });

      await dingtalk.sendMessage(msg.sessionWebhook, dingtalkReply);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error("processing failed", { error: errorMsg });

      await dingtalk.sendTextMessage(
        msg.sessionWebhook,
        `处理消息时出错，请稍后重试：${errorMsg}`
      );
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
