import fs from "node:fs";
import path from "node:path";
import { realpathSync } from "node:fs";
import { Logger } from "./logger.js";

const log = new Logger("ProjectRegistry");

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  description?: string;
}

export class ProjectRegistry {
  private projects: ProjectConfig[] = [];

  constructor(
    private configPath: string,
    private allowedRoots: string[],
  ) {
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.configPath)) {
        log.warn("projects config not found", { path: this.configPath });
        this.projects = [];
        return;
      }

      const raw = fs.readFileSync(this.configPath, "utf-8");
      const data = JSON.parse(raw) as ProjectConfig[];
      this.projects = this.validate(data);
      log.info("projects config loaded", { count: this.projects.length });
    } catch (err) {
      log.error("failed to load projects config", { error: String(err) });
      this.projects = [];
    }
  }

  private validate(projects: ProjectConfig[]): ProjectConfig[] {
    const ids = new Set<string>();
    const names = new Set<string>();
    const result: ProjectConfig[] = [];
    let roots: string[];
    try {
      roots = this.allowedRoots.map((root) => realpathSync(root));
    } catch {
      log.warn("failed to resolve allowed roots, skipping root check", { roots: this.allowedRoots });
      roots = [];
    }

    for (const project of projects) {
      if (!project.id || !project.name || !project.path) {
        log.warn("skipping project: missing required fields (id/name/path)", { project });
        continue;
      }
      if (ids.has(project.id)) {
        log.warn("skipping project: duplicate id", { id: project.id });
        continue;
      }
      if (names.has(project.name)) {
        log.warn("skipping project: duplicate name", { name: project.name });
        continue;
      }
      if (!path.isAbsolute(project.path)) {
        log.warn("skipping project: path must be absolute", { id: project.id, path: project.path });
        continue;
      }
      if (!fs.existsSync(project.path) || !fs.statSync(project.path).isDirectory()) {
        log.warn("skipping project: path is not a directory", { id: project.id, path: project.path });
        continue;
      }

      // SVR-REG-08: 检查项目目录是否包含标志文件
      const markerFiles = [".git", "opencode.json", "AGENTS.md", "package.json", "pyproject.toml", "go.mod"];
      const hasMarker = markerFiles.some((f) => fs.existsSync(path.join(project.path, f)));
      if (!hasMarker) {
        log.warn("project directory has no recognized marker files", { path: project.path, markers: markerFiles });
      }

      const realProjectPath = realpathSync(project.path);
      if (roots.length > 0 && !roots.some((root) => this.isInsideRoot(realProjectPath, root))) {
        log.warn("skipping project: path is outside allowed roots", { id: project.id, path: project.path });
        continue;
      }

      ids.add(project.id);
      names.add(project.name);
      result.push({ ...project, path: realProjectPath });
    }

    return result;
  }

  private isInsideRoot(projectPath: string, root: string): boolean {
    return projectPath === root || projectPath.startsWith(`${root}${path.sep}`);
  }

  list(): ProjectConfig[] {
    return [...this.projects];
  }

  find(identifier: string): ProjectConfig | undefined {
    const key = identifier.trim();
    return this.projects.find((project) => project.id === key || project.name === key);
  }
}
