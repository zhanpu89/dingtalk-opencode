import type { AppConfig } from "./config.js";
import type {
  OpenCodeMessageResponse,
  OpenCodeSession,
  OpenCodeSessionListResponse,
  SummaryResult,
  OpenCodePart,
} from "./types.js";
import { Logger } from "./logger.js";

const log = new Logger("OpenCodeClient");

export class OpenCodeClient {
  private baseUrl: string;
  private authHeader: string | null;
  private timeoutMs: number;

  constructor(config: AppConfig) {
    this.baseUrl = config.opencodeServerUrl;
    this.timeoutMs = config.requestTimeoutMs;
    this.authHeader = config.opencodeServerPassword
      ? "Basic " +
        Buffer.from(
          `opencode:${config.opencodeServerPassword}`
        ).toString("base64")
      : null;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `opencode API error ${res.status} on ${method} ${path}: ${text}`
        );
      }
      return res.json() as Promise<T>;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(
          `opencode API timeout after ${this.timeoutMs}ms on ${method} ${path}`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async createSession(title?: string): Promise<OpenCodeSession> {
    const sessions = await this.request<OpenCodeSessionListResponse[]>(
      "GET",
      "/session"
    );
    const existing = sessions.find((s) => s.title === title);
    if (existing) {
      return existing as unknown as OpenCodeSession;
    }
    return this.request<OpenCodeSession>("POST", "/session", { title });
  }

  async sendMessage(
    sessionId: string,
    text: string
  ): Promise<OpenCodeMessageResponse> {
    log.debug("sending message (streaming)", {
      sessionId: sessionId.slice(0, 8),
      text: text.slice(0, 60),
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }

    const controller = new AbortController();
    const result: OpenCodeMessageResponse = {
      info: { id: "", sessionID: sessionId, role: "assistant" },
      parts: [],
    };

    // Phase 1: wait for initial HTTP response (connection timeout)
    const connectTimer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/session/${sessionId}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify({ parts: [{ type: "text", text }] }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(connectTimer);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `opencode API error ${res.status} on POST /session/${sessionId}/message: ${body}`,
      );
    }

    // Phase 2: read SSE stream with per-chunk idle timeout
    // The AbortController.signal is still associated with the response body,
    // so aborting it will reject reader.read().
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let currentEvent = "";
    let currentPart: OpenCodePart | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), this.timeoutMs);
    };

    function flushLine(line: string) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(line.slice(6));
        } catch {
          return;
        }

        switch (currentEvent) {
          case "message_start": {
            const msg = data.message as Record<string, unknown> | undefined;
            if (msg) {
              result.info = {
                id: (msg.id as string) ?? "",
                sessionID: (msg.sessionID as string) ?? sessionId,
                role: "role" in msg ? (msg.role as string) : "assistant",
              };
            }
            break;
          }
          case "content_block_start": {
            const block = data.content_block as Record<string, unknown> | undefined;
            if (!block) break;
            const type = block.type as string;
            currentPart = { type, ...block } as OpenCodePart;
            if (type === "text") {
              currentPart.text = (currentPart.text as string) ?? "";
            }
            result.parts.push(currentPart);
            break;
          }
          case "content_block_delta": {
            const delta = data.delta as Record<string, unknown> | undefined;
            if (!delta || delta.type !== "text") break;
            if (currentPart?.type === "text") {
              currentPart.text = (currentPart.text ?? "") + (delta.text as string);
            }
            break;
          }
          case "content_block_stop":
            currentPart = null;
            break;
          case "error": {
            const errData = data.error as Record<string, unknown> | undefined;
            throw new Error(
              `opencode stream error: ${errData?.message ?? JSON.stringify(data)}`,
            );
          }
        }
      }
    }

    try {
      resetIdleTimer();

      while (true) {
        const { done, value } = await reader.read();
        resetIdleTimer();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          flushLine(line);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `opencode stream timed out after ${this.timeoutMs}ms without data`,
        );
      }
      throw err;
    } finally {
      clearTimeout(idleTimer);
    }

    if (buf.trim()) {
      flushLine(buf);
    }

    return result;
  }

  async shareSession(sessionId: string): Promise<string | null> {
    try {
      const result = await this.request<{ id: string; shareURL?: string }>(
        "POST",
        `/session/${sessionId}/share`
      );
      return result.shareURL || null;
    } catch (err) {
      log.warn("failed to share session", { sessionId: sessionId.slice(0, 8), error: String(err) });
      return null;
    }
  }

  extractSummary(response: OpenCodeMessageResponse): SummaryResult {
    const textParts = response.parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!.trim())
      .filter(Boolean);

    let summary = "(无文本回复)";
    if (textParts.length > 0) {
      const paragraphs = textParts[0].split(/\n\n+/).filter(Boolean);
      summary = paragraphs[0] || textParts[0];
      if (summary.length > 200) {
        summary = summary.slice(0, 200) + "...";
      }
    }

    const changedFiles: string[] = [];
    for (const part of response.parts) {
      if (
        part.type === "tool_use" &&
        part.name &&
        typeof part.name === "string"
      ) {
        const filePath =
          (part as Record<string, unknown>).filePath ||
          (part as Record<string, unknown>).path;
        if (filePath && typeof filePath === "string") {
          changedFiles.push(filePath);
        }
      }
    }

    return {
      summary,
      changedFiles: [...new Set(changedFiles)],
      fullLength: textParts.reduce((sum, t) => sum + t.length, 0),
    };
  }

  async health(): Promise<boolean> {
    try {
      await this.request<{ healthy: boolean }>("GET", "/global/health");
      return true;
    } catch {
      return false;
    }
  }
}
