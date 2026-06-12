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

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }

    const controller = new AbortController();

    // Phase 1: wait for initial HTTP response headers
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

    // Phase 2: stream the JSON body with per-chunk idle timeout.
    // The endpoint returns Content-Type: application/json but uses Hono's
    // stream(), so the body arrives in chunks as the AI generates.
    // Concatenate all chunks and parse as JSON.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), this.timeoutMs);
    };

    try {
      resetIdleTimer();

      while (true) {
        const { done, value } = await reader.read();
        resetIdleTimer();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
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

    // Consume remaining decoder buffer
    raw += decoder.decode();

    return JSON.parse(raw) as OpenCodeMessageResponse;
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

  /** Convert wide tables (>=4 columns) to compact key-value list for narrow DingTalk card */
  private reformatWideTables(text: string): string {
    const lines = text.split("\n");
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
      const trimmed = lines[i].trim();
      if (
        trimmed.startsWith("|") &&
        i + 1 < lines.length &&
        /^\|[\s\|:-]+\|$/.test(lines[i + 1].trim())
      ) {
        const tableLines: string[] = [];
        while (i < lines.length && lines[i].trim().startsWith("|")) {
          tableLines.push(lines[i]);
          i++;
        }
        result.push(this.compactTable(tableLines));
      } else {
        result.push(lines[i]);
        i++;
      }
    }
    return result.join("\n");
  }

  /** Compact a markdown table into key-value format if it has >=4 columns */
  private compactTable(tableLines: string[]): string {
    if (tableLines.length < 3) return tableLines.join("\n");

    const headers = tableLines[0]
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    if (headers.length < 4) return tableLines.join("\n");

    const dataRows = tableLines.slice(2);
    const entries: string[] = [];

    for (const row of dataRows) {
      const cells = row
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      const pairs: [string, string][] = [];
      for (let j = 0; j < Math.min(headers.length, cells.length); j++) {
        pairs.push([headers[j], cells[j]]);
      }
      const pairLines: string[] = [];
      for (let k = 0; k < pairs.length; k += 3) {
        const group = pairs.slice(k, k + 3);
        pairLines.push(group.map(([h, v]) => `**${h}**: ${v}`).join("  "));
      }
      entries.push(pairLines.join("\n"));
      entries.push("");
    }

    return entries.join("\n").trim();
  }

  extractSummary(response: OpenCodeMessageResponse): SummaryResult {
    const textParts = response.parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!.trim())
      .filter(Boolean);

    let summary = "(无文本回复)";
    if (textParts.length > 0) {
      const paragraphs = textParts[0].split(/\n\n+/).filter(Boolean);
      // 取前 3 段，每段最多 500 字，总计上限 1000 字
      // 保留段落内换行（Markdown 表格/列表/代码块需要换行才能正确渲染）
      const kept: string[] = [];
      let totalLen = 0;
      for (const p of paragraphs) {
        const trimmed = p.trim();
        if (!trimmed) continue;
        const slice = trimmed.length > 500 ? trimmed.slice(0, 500) + "..." : trimmed;
        if (totalLen + slice.length > 1000) {
          kept.push(slice.slice(0, 1000 - totalLen) + "...");
          totalLen = 1000;
          break;
        }
        kept.push(slice);
        totalLen += slice.length;
      }
      summary = kept.join("\n\n");
      summary = this.reformatWideTables(summary);
    }

    const changedFiles: string[] = [];
    const toolNames = new Set<string>();
    for (const part of response.parts) {
      if (part.type === "tool_call") {
        if (part.name && typeof part.name === "string") {
          toolNames.add(part.name);
        }
      }
      if (
        part.type === "tool_use" &&
        part.name &&
        typeof part.name === "string"
      ) {
        toolNames.add(part.name);
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
      toolNames: [...toolNames],
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
