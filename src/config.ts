export interface AppConfig {
  opencodeServerUrl: string;
  opencodeServerPassword: string;
  dingtalkAppKey: string;
  dingtalkAppSecret: string;
  dingtalkBotName: string;
  requestTimeoutMs: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  logLevel: string;
  dataDir: string;
  projectsConfigPath: string;
  allowedProjectRoots: string[];
  projectServerPortStart: number;
  projectServerHostname: string;
  projectServerIdleMs: number;
  projectSwitchRequired: boolean;
}

function envStr(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v) {
    const n = parseInt(v, 10);
    if (!isNaN(n)) return n;
  }
  return fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (!v) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function envList(key: string): string[] {
  return envStr(key)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export function loadConfig(): AppConfig {
  return {
    opencodeServerUrl: envStr("OPENCODE_SERVER_URL", "http://localhost:4096"),
    opencodeServerPassword: envStr("OPENCODE_SERVER_PASSWORD"),
    dingtalkAppKey: envStr("DINGTALK_APP_KEY"),
    dingtalkAppSecret: envStr("DINGTALK_APP_SECRET"),
    dingtalkBotName: envStr("DINGTALK_BOT_NAME", "OpenCode"),
    requestTimeoutMs: envInt("REQUEST_TIMEOUT_MS", 600_000),
    rateLimitMax: envInt("RATE_LIMIT_MAX", 20),
    rateLimitWindowMs: envInt("RATE_LIMIT_WINDOW_MS", 60_000),
    logLevel: envStr("LOG_LEVEL", "INFO"),
    dataDir: envStr("DATA_DIR", "data"),
    projectsConfigPath: envStr("PROJECTS_CONFIG_PATH", "projects.json"),
    allowedProjectRoots: envList("ALLOWED_PROJECT_ROOTS"),
    projectServerPortStart: envInt("PROJECT_SERVER_PORT_START", 4100),
    projectServerHostname: envStr("PROJECT_SERVER_HOSTNAME", "127.0.0.1"),
    projectServerIdleMs: envInt("PROJECT_SERVER_IDLE_MS", 7_200_000),
    projectSwitchRequired: envBool("PROJECT_SWITCH_REQUIRED", false),
  };
}
