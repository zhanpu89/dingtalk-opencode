import type { AppConfig } from "./config.js";
import type {
  OpenCodeMessageResponse,
  OpenCodeSession,
  OpenCodeSessionListResponse,
  SummaryResult,
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
    log.debug("sending message", {
      sessionId: sessionId.slice(0, 8),
      text: text.slice(0, 60),
    });
    return this.request<OpenCodeMessageResponse>(
      "POST",
      `/session/${sessionId}/message`,
      {
        parts: [{ type: "text", text }],
      }
    );
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
