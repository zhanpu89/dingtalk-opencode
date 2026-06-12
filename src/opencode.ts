import type { AppConfig } from "./config.js";
import type {
  OpenCodeMessageResponse,
  OpenCodeSession,
  OpenCodeSessionListResponse,
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

  extractResponseText(response: OpenCodeMessageResponse): string {
    const textParts = response.parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!.trim())
      .filter(Boolean);

    if (textParts.length === 0) {
      const toolParts = response.parts.filter((p) => p.type === "tool_use");
      if (toolParts.length > 0) {
        let summary = "使用了以下工具：\n";
        for (const tp of toolParts) {
          summary += `- ${tp.name || "unknown"}\n`;
        }
        return summary;
      }
      return "(无文本回复)";
    }

    return textParts.join("\n\n");
  }

  async health(): Promise<boolean> {
    try {
      await this.request<{ healthy: boolean }>(
        "GET",
        "/global/health"
      );
      return true;
    } catch (err) {
      return false;
    }
  }
}
