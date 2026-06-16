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
    const roots = this.allowedRoots.map((root) => realpathSync(root));

    for (const project of projects) {
      if (!project.id || !project.name || !project.path) {
        throw new Error("project id, name and path are required");
      }
      if (ids.has(project.id)) {
        throw new Error(`duplicate project id: ${project.id}`);
      }
      if (names.has(project.name)) {
        throw new Error(`duplicate project name: ${project.name}`);
      }
      if (!path.isAbsolute(project.path)) {
        throw new Error(`project path must be absolute: ${project.path}`);
      }
      if (!fs.existsSync(project.path) || !fs.statSync(project.path).isDirectory()) {
        throw new Error(`project path is not a directory: ${project.path}`);
      }

      const realProjectPath = realpathSync(project.path);
      if (roots.length > 0 && !roots.some((root) => this.isInsideRoot(realProjectPath, root))) {
        throw new Error(`project path is outside allowed roots: ${project.path}`);
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
