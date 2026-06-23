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
 * 渐进式心跳间隔（毫秒）：1min → 2min → 4min → 5min（上限）
 */
export const HEARTBEAT_INTERVALS = [60_000, 120_000, 240_000, 300_000];

/**
 * 超时探测延迟配置（可被测试覆盖）
 */
export const ProbeConfig = {
  baseDelayMs: 5_000,
  maxDelayMs: 20_000,
};

/**
 * 可被 AbortSignal 中断的延迟函数（每 1s 检查一次信号）
 */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const step = 1_000;
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += step;
      if (elapsed >= ms || signal.aborted) {
        clearInterval(timer);
        resolve();
      }
    }, step);
  });
}

/**
 * 运行渐进式心跳，通过 AbortSignal 停止（快速响应，无需等待完整间隔）
 */
async function runHeartbeat(
  webhook: string,
  dingtalk: DingTalkClient,
  stopSignal: AbortSignal,
): Promise<void> {
  for (let i = 0; i < HEARTBEAT_INTERVALS.length; i++) {
    if (stopSignal.aborted) return;
    await abortableDelay(HEARTBEAT_INTERVALS[i], stopSignal);
    if (stopSignal.aborted) return;
    try {
      await dingtalk.sendTextMessage(webhook, `⏳ 正在处理中，请稍候...`);
    } catch {
      // webhook may expire; ignore
    }
  }
}

/**
 * 超时/断连后探测会话是否仍在活跃处理。
 * 如果 session 仍然存在且可访问，说明服务端任务可能还在运行，
 * 等待冷却期后再决定是否重试。
 */
async function probeSessionActive(
  opencode: OpenCodeClient,
  sessionId: string,
): Promise<boolean> {
  try {
    const exists = await opencode.sessionExists(sessionId);
    // session 存在说明服务还在处理，等待冷却
    return exists === true;
  } catch {
    return false;
  }
}

/**
 * 发送重试通知消息（仅当与上一条通知间隔足够时才实际发送）
 */
let lastRetryNotify = 0;
async function sendRetryNotification(
  dingtalk: DingTalkClient,
  webhook: string,
  text: string,
): Promise<void> {
  const now = Date.now();
  if (now - lastRetryNotify < 30_000) return; // 30s 去重
  lastRetryNotify = now;
  try {
    await dingtalk.sendTextMessage(webhook, text);
  } catch { /* ignore */ }
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
  const heartbeatStopSignal = new AbortController();

  // 渐进式心跳：不再固定 60s 重复发送
  const heartbeatPromise = runHeartbeat(msg.sessionWebhook, dingtalk, heartbeatStopSignal.signal);

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

      // Watchdog monitors health independently (no shared AbortController for transient checks).
      // A criticalAbort controller is set on the watchdog so that ONLY definitive state changes
      // (session vanished → "restart" | 3 consecutive health failures → "server_down")
      // will abort the in-flight sendMessage, allowing the retry loop to respond promptly.
      const criticalAbort = new AbortController();
      watchdog = new Watchdog(opencode, currentSessionId);
      watchdog.setCriticalAbort(criticalAbort);
      watchdog.start();

      const response = await opencode.sendMessage(currentSessionId, message, criticalAbort.signal);
      watchdog.stop();
      heartbeatStopSignal.abort();
      await heartbeatPromise.catch(() => {});

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

      // ── 超时/断连：先探测服务端任务是否仍在处理 ──
      const isTimeout = err instanceof Error && err.name === "AbortError";
      const isNetworkError = err instanceof TypeError && err.message === "fetch failed";

      // 对超时和网络错误，先探测再决定是否重试
      if ((isTimeout || isNetworkError) && retries < maxRetries && currentSessionId) {
        const probeDelay = Math.min(ProbeConfig.baseDelayMs * Math.pow(2, retries), ProbeConfig.maxDelayMs);
        log.info("probing session after abort/disconnect", {
          sessionId: currentSessionId.slice(0, 8),
          probeDelayMs: probeDelay,
          isTimeout,
        });

        // 等待冷却期，给服务端任务完成的机会
        await new Promise((r) => setTimeout(r, probeDelay));

        const stillActive = await probeSessionActive(opencode, currentSessionId);
        if (stillActive) {
          // 服务端任务仍在处理中 → 继续等待，不重试不放弃
          log.info("session still active after abort, extending wait", {
            sessionId: currentSessionId.slice(0, 8),
          });
          // 用原来的 session 重试 sendMessage（不创建新 session）
          retries++;
          shouldRetry = true;
          await sendRetryNotification(
            dingtalk,
            msg.sessionWebhook,
            `⏳ 任务仍在处理中，请耐心等待...（第 ${retries} 次重连）`
          );
          // 保留 currentSessionId，不创建新 session
          continue;
        }

        // session 已消失 → 安全创建新 session 重试
        log.warn("session gone after abort, creating new session", {
          oldSessionId: currentSessionId?.slice(0, 8),
          attempt: retries + 1,
        });
      }

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
          await sendRetryNotification(
            dingtalk,
            msg.sessionWebhook,
            `⏳ OpenCode 连接中断，已切换新会话重试（第 ${retries} 次）...`
          );
        } catch (retryErr) {
          log.error("retry session creation failed", { error: String(retryErr) });
          shouldRetry = false;
          heartbeatStopSignal.abort();
          await heartbeatPromise.catch(() => {});
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

          await sendRetryNotification(
            dingtalk,
            msg.sessionWebhook,
            `⏳ 检测到任务异常，正在重新处理（第 ${retries} 次重试）...`
          );
        } catch (retryErr) {
          log.error("retry session creation failed", { error: String(retryErr) });
          shouldRetry = false;
          heartbeatStopSignal.abort();
          await heartbeatPromise.catch(() => {});
          await sendProcessingError(dingtalk, config, msg.sessionWebhook, watchdog?.state, retryErr, sessionId, false);
        }

        continue;
      }

      if (isTimeout && retries < maxRetries) {
        retries++;
        shouldRetry = true;

        log.warn("abort error, retrying with new session after probe", {
          attempt: retries,
          sessionKey,
        });

        try {
          const newSession = await opencode.createSession(`钉钉-${msg.senderNick}`);
          currentSessionId = newSession.id;
          sessions.set(sessionKey, currentSessionId);

          await sendRetryNotification(
            dingtalk,
            msg.sessionWebhook,
            `⏳ 任务超时，正在重新处理（第 ${retries} 次重试）...`
          );
        } catch (retryErr) {
          log.error("retry session creation failed", { error: String(retryErr) });
          shouldRetry = false;
          heartbeatStopSignal.abort();
          await heartbeatPromise.catch(() => {});
          await sendProcessingError(dingtalk, config, msg.sessionWebhook, watchdog?.state, retryErr, sessionId, false);
        }

        continue;
      }

      // 500 Server Error: API 返回 5xx，可能是服务端临时故障或坏会话
      // 创建新会话（带时间戳避免复用坏会话）并重试
      const isServerError = err instanceof Error && /opencode API error 5\d\d/.test(err.message);
      if (isServerError && retries < maxRetries) {
        retries++;
        shouldRetry = true;

        log.warn("server error, retrying with new session", {
          attempt: retries,
          oldSessionId: currentSessionId?.slice(0, 8),
          error: err.message.slice(0, 120),
        });

        // 删除坏会话，避免后续复用
        sessions.delete(sessionKey);

        try {
          const newSession = await opencode.createSession(`钉钉-${msg.senderNick}-${Date.now()}`);
          currentSessionId = newSession.id;
          sessions.set(sessionKey, currentSessionId);

          await sendRetryNotification(
            dingtalk,
            msg.sessionWebhook,
            `⏳ OpenCode 服务异常，正在切换新会话重试（第 ${retries} 次）...`
          );
        } catch (retryErr) {
          log.error("retry session creation failed after server error", { error: String(retryErr) });
          shouldRetry = false;
          heartbeatStopSignal.abort();
          await heartbeatPromise.catch(() => {});
          await sendProcessingError(dingtalk, config, msg.sessionWebhook, watchdog?.state, retryErr, sessionId, false);
        }

        continue;
      }

      heartbeatStopSignal.abort();
      await heartbeatPromise.catch(() => {});
      await sendProcessingError(dingtalk, config, msg.sessionWebhook, watchdog?.state, err, sessionId, isTimeout);
    }
  } while (shouldRetry);
}
