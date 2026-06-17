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
    const tracked = next.catch(() => {});
    this.chains.set(sessionKey, tracked);
    tracked.finally(() => {
      setTimeout(() => {
        if (this.chains.get(sessionKey) === tracked) {
          this.chains.delete(sessionKey);
        }
      }, 1000);
    }).catch(() => {});
    return next;
  }

  isBusy(sessionKey: string): boolean {
    return this.chains.has(sessionKey);
  }

  pendingCount(): number {
    return this.chains.size;
  }
}
