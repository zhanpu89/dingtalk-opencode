import type { DingTalkSendBody } from "./types.js";
import { Logger } from "./logger.js";

const log = new Logger("DingTalk");

export class DingTalkClient {
  constructor(
    private botName: string,
  ) {}

  private async send(
    webhookUrl: string,
    body: DingTalkSendBody,
  ): Promise<void> {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        log.warn("DingTalk API returned non-ok", { status: res.status, body: text.slice(0, 200) });
      }
    } catch (err) {
      log.warn("DingTalk send failed (network error)", { error: String(err) });
    }
  }

  async sendMessage(webhookUrl: string, content: { title: string; text: string }): Promise<void> {
    await this.send(webhookUrl, {
      msgtype: "markdown",
      markdown: { title: content.title, text: content.text },
    });
  }

  async sendTextMessage(webhookUrl: string, content: string): Promise<void> {
    await this.send(webhookUrl, {
      msgtype: "text",
      text: { content },
    });
  }
}
