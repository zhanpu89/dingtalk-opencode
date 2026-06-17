import type { RobotTextMessage } from "dingtalk-stream";
import type { AppConfig } from "./config.js";
import type { OpenCodeClient } from "./opencode.js";
import type { DingTalkClient } from "./dingtalk.js";
import type { SessionStore } from "./session-store.js";
import { Watchdog } from "./watchdog.js";
import { Logger } from "./logger.js";

const log = new Logger("AIHandler");

export function buildReplyMessage(
  summary: string,
  changedFiles: string[],
  toolNames: string[],
  fullLength: number,
  shareUrl: string | null,
  sessionId: string,
): { title: string; text: string } {
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

  return { title: "OpenCode 任务完成", text: parts.join("\n") };
}

export async function sendProcessingError(
  dingtalk: DingTalkClient,
  config: AppConfig,
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

export interface AIMessageContext {
  opencode: OpenCodeClient;
  dingtalk: DingTalkClient;
  config: AppConfig;
  sessions: SessionStore;
}

/**
 * Process an AI message with full retry/watchdog/heartbeat lifecycle.
 * Called from the queue runner in index.ts.
 */
export async function processAIMessage(
  ctx: AIMessageContext,
  sessionKey: string,
  message: string,
  msg: RobotTextMessage,
): Promise<void> {
  const { opencode, dingtalk, config, sessions } = ctx;
  let sessionId: string | undefined;
  let heartbeatCount = 0;
  const heartbeat = setInterval(async () => {
    heartbeatCount++;
    try {
      await dingtalk.sendTextMessage(
        msg.sessionWebhook,
        `⏳ 正在处理中，请稍候...`
      );
    } catch {
      // webhook may expire after long idle; ignore heartbeat errors
    }
  }, 60_000);

  let currentSessionId: string | undefined;
  let retries = 0;
  const maxRetries = 3;
  let shouldRetry = false;

  do {
    shouldRetry = false;

    if (retries > 0) {
      const delay = Math.min(1000 * Math.pow(2, retries - 1), 10_000);
      await new Promise((r) => setTimeout(r, delay));
    }

    const abortController = new AbortController();
    let watchdog: Watchdog | undefined;

    try {
      currentSessionId = sessions.get(sessionKey);

      // 验证 session 是否仍有效（opencode serve 重启后旧 ID 会失效）
      if (currentSessionId) {
        const exists = await opencode.sessionExists(currentSessionId);
        if (exists === false) {
          log.warn("stale session detected, creating new one", {
            oldSessionId: currentSessionId.slice(0, 8),
          });
          sessions.delete(sessionKey);
          currentSessionId = undefined;
        }
      }

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
          await sendProcessingError(dingtalk, config, msg.sessionWebhook, watchdog?.state, retryErr, sessionId, false);
        }

        continue;
      }

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
          await sendProcessingError(dingtalk, config, msg.sessionWebhook, watchdog?.state, retryErr, sessionId, false);
        }

        continue;
      }

      const isTimeout = err instanceof Error && err.name === "AbortError";
      if (isTimeout && retries < maxRetries) {
        retries++;
        shouldRetry = true;

        log.warn("abort error, retrying", {
          attempt: retries,
          sessionKey,
        });

        try {
          const newSession = await opencode.createSession(`钉钉-${msg.senderNick}`);
          currentSessionId = newSession.id;
          sessions.set(sessionKey, currentSessionId);

          await dingtalk.sendTextMessage(
            msg.sessionWebhook,
            `⏳ 任务超时，正在重新处理（第 ${retries} 次重试）...`
          ).catch(() => {});
        } catch (retryErr) {
          log.error("retry session creation failed", { error: String(retryErr) });
          shouldRetry = false;
          clearInterval(heartbeat);
          await sendProcessingError(dingtalk, config, msg.sessionWebhook, watchdog?.state, retryErr, sessionId, false);
        }

        continue;
      }

      clearInterval(heartbeat);
      await sendProcessingError(dingtalk, config, msg.sessionWebhook, watchdog?.state, err, sessionId, isTimeout);
    }
  } while (shouldRetry);
}
