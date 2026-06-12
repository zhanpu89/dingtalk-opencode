import crypto from "node:crypto";
import type { DingTalkSendBody } from "./types.js";

export class DingTalkClient {
  private botName: string;

  constructor(botName: string) {
    this.botName = botName;
  }

  verifySignature(
    appSecret: string,
    timestamp: string,
    signature: string
  ): boolean {
    const hmac = crypto.createHmac("sha256", appSecret);
    hmac.update(`${timestamp}\n${appSecret}`);
    const expected = hmac.digest("base64");
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature)
    );
  }

  stripBotMention(text: string): string {
    const atPattern = new RegExp(`@${this.botName}\\s*`, "g");
    return text.replace(atPattern, "").trim();
  }

  async sendMessage(
    webhookUrl: string,
    content: string
  ): Promise<void> {
    const body: DingTalkSendBody = {
      msgtype: "markdown",
      markdown: {
        title: "OpenCode 回复",
        text: content,
      },
    };

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[DingTalk] send failed: ${res.status} - ${text}`);
    }
  }

  async sendTextMessage(
    webhookUrl: string,
    content: string
  ): Promise<void> {
    const body: DingTalkSendBody = {
      msgtype: "text",
      text: { content },
    };

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[DingTalk] send failed: ${res.status} - ${text}`);
    }
  }
}
