import fs from "node:fs";
import path from "node:path";
import { Logger } from "./logger.js";

const log = new Logger("SessionStore");

export class SessionStore {
  private map: Map<string, string>;
  private roundMap: Map<string, number>;
  private filePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null;

  constructor(filePath?: string) {
    this.map = new Map();
    this.roundMap = new Map();
    this.filePath = filePath || path.resolve("data", "session-map.json");
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
      log.error("failed to load session store, trying backup", { error: String(err) });
      try {
        if (fs.existsSync(this.filePath + ".bak")) {
          const bakRaw = fs.readFileSync(this.filePath + ".bak", "utf-8");
          const bakData = JSON.parse(bakRaw) as Record<string, string>;
          for (const [k, v] of Object.entries(bakData)) {
            this.map.set(k, v);
          }
          log.info("session store recovered from backup", { entries: this.map.size });
          return;
        }
      } catch { /* backup also corrupt */ }
      log.error("backup also corrupt, starting with empty map");
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 2000);
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      const obj: Record<string, string> = {};
      for (const [k, v] of this.map) {
        obj[k] = v;
      }
      const jsonStr = JSON.stringify(obj, null, 2);
      const tmpPath = this.filePath + ".tmp";
      const bakPath = this.filePath + ".bak";
      fs.writeFileSync(tmpPath, jsonStr, "utf-8");
      try { fs.renameSync(this.filePath, bakPath); } catch { /* 首次写入无旧文件 */ }
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      log.error("failed to flush session store", { error: String(err) });
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

  // ── Round count tracking (in-memory only, not persisted) ──

  getRoundCount(key: string): number {
    return this.roundMap.get(key) ?? 0;
  }

  incrementRound(key: string): number {
    const count = (this.roundMap.get(key) ?? 0) + 1;
    this.roundMap.set(key, count);
    return count;
  }

  resetRound(key: string): void {
    this.roundMap.set(key, 0);
  }

  /** Clear all round counters (e.g., after server recycle) */
  clearAllRounds(): void {
    this.roundMap.clear();
  }
}
