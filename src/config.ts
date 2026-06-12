export interface AppConfig {
  opencodeServerUrl: string;
  opencodeServerPassword: string;
  dingtalkAppKey: string;
  dingtalkAppSecret: string;
  dingtalkBotName: string;
  port: number;
  requestTimeoutMs: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  logLevel: string;
  dataDir: string;
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

export function loadConfig(): AppConfig {
  return {
    opencodeServerUrl: envStr("OPENCODE_SERVER_URL", "http://localhost:4096"),
    opencodeServerPassword: envStr("OPENCODE_SERVER_PASSWORD"),
    dingtalkAppKey: envStr("DINGTALK_APP_KEY"),
    dingtalkAppSecret: envStr("DINGTALK_APP_SECRET"),
    dingtalkBotName: envStr("DINGTALK_BOT_NAME", "OpenCode"),
    port: envInt("PORT", 3000),
    requestTimeoutMs: envInt("REQUEST_TIMEOUT_MS", 600_000),
    rateLimitMax: envInt("RATE_LIMIT_MAX", 20),
    rateLimitWindowMs: envInt("RATE_LIMIT_WINDOW_MS", 60_000),
    logLevel: envStr("LOG_LEVEL", "INFO"),
    dataDir: envStr("DATA_DIR", "data"),
  };
}
