import fs from "node:fs";
import path from "node:path";
import { Logger } from "./logger.js";

const log = new Logger("ProjectContextStore");

/**
 * No-cache approach: 每次读写都直接操作磁盘文件，以原子方式保证一致性。
 * 这是最慢但最可靠的实现，适合低频访问的场景。
 */
export class ProjectContextStore {
  constructor(private filePath = path.resolve("data", "project-context.json")) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    log.info("project context store ready", { path: this.filePath });
  }

  /** 从磁盘读取全部上下文 */
  private readAll(): Record<string, string> {
    try {
      if (!fs.existsSync(this.filePath)) return {};
      const raw = fs.readFileSync(this.filePath, "utf-8");
      return JSON.parse(raw) as Record<string, string>;
    } catch (err) {
      log.error("failed to read project context", { error: String(err) });
      return {};
    }
  }

  /** 原子写入全部上下文 */
  private writeAll(data: Record<string, string>): void {
    try {
      const json = JSON.stringify(data, null, 2);
      const tmp = this.filePath + ".tmp";
      fs.writeFileSync(tmp, json, "utf-8");
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      log.error("failed to write project context", { error: String(err) });
    }
  }

  get(key: string): string | undefined {
    return this.readAll()[key];
  }

  set(key: string, projectId: string): void {
    const data = this.readAll();
    data[key] = projectId;
    this.writeAll(data);
  }

  delete(key: string): void {
    const data = this.readAll();
    delete data[key];
    this.writeAll(data);
  }

  clearAll(): void {
    this.writeAll({});
  }
}
