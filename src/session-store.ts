import fs from "node:fs";
import path from "node:path";
import { Logger } from "./logger.js";

const log = new Logger("SessionStore");

export class SessionStore {
  private map: Map<string, string>;
  private filePath: string;
  private dirty: boolean;
  private saveTimer: ReturnType<typeof setTimeout> | null;

  constructor(filePath?: string) {
    this.map = new Map();
    this.filePath = filePath || path.resolve("data", "session-map.json");
    this.dirty = false;
    this.saveTimer = null;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        log.info("session store created", { path: this.filePath });
        return;
      }
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as Record<string, string>;
      for (const [k, v] of Object.entries(data)) {
        this.map.set(k, v);
      }
      log.info("session store loaded", { entries: this.map.size });
    } catch (err) {
      log.error("failed to load session store", { error: String(err) });
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 2000);
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      const obj: Record<string, string> = {};
      for (const [k, v] of this.map) {
        obj[k] = v;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), "utf-8");
    } catch (err) {
      log.error("failed to save session store", { error: String(err) });
    }
  }

  get(key: string): string | undefined {
    return this.map.get(key);
  }

  set(key: string, sessionId: string): void {
    this.map.set(key, sessionId);
    this.scheduleSave();
  }

  delete(key: string): void {
    this.map.delete(key);
    this.scheduleSave();
  }

  size(): number {
    return this.map.size;
  }
}
