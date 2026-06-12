import { Logger } from "./logger.js";

const log = new Logger("MessageQueue");

export class MessageQueue {
  private chains = new Map<string, Promise<void>>();

  async enqueue(
    sessionKey: string,
    fn: () => Promise<void>
  ): Promise<void> {
    const prev = this.chains.get(sessionKey) ?? Promise.resolve();
    const next = prev.then(() => fn(), () => fn());
    this.chains.set(sessionKey, next.catch(() => {}));
    return next;
  }

  pendingCount(): number {
    return this.chains.size;
  }
}
