import fs from "node:fs";
import path from "node:path";
import { Logger } from "./logger.js";

const log = new Logger("ProjectContextStore");

export class ProjectContextStore {
  private map = new Map<string, string>();

  constructor(private filePath = path.resolve("data", "project-context.json")) {
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        log.info("project context store created", { path: this.filePath });
        return;
      }
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as Record<string, string>;
      for (const [k, v] of Object.entries(data)) {
        this.map.set(k, v);
      }
      log.info("project context store loaded", { entries: this.map.size });
    } catch (err) {
      log.error("failed to load project context store", { error: String(err) });
    }
  }

  get(key: string): string | undefined {
    return this.map.get(key);
  }

  set(key: string, projectId: string): void {
    this.map.set(key, projectId);
    this.writeFile();
  }

  delete(key: string): void {
    this.map.delete(key);
    this.writeFile();
  }

  clearAll(): void {
    this.map.clear();
    this.writeFile();
  }

  private writeFile(): void {
    try {
      const obj: Record<string, string> = {};
      for (const [k, v] of this.map) {
        obj[k] = v;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), "utf-8");
    } catch (err) {
      log.error("failed to write project context", { error: String(err) });
    }
  }
}
