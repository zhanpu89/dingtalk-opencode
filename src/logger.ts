const LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;
type Level = (typeof LEVELS)[number];

const COLORS: Record<Level, string> = {
  DEBUG: "\x1b[36m",
  INFO: "\x1b[32m",
  WARN: "\x1b[33m",
  ERROR: "\x1b[31m",
};
const RESET = "\x1b[0m";

export class Logger {
  private name: string;
  private minLevel: Level;

  constructor(name: string, minLevel: Level = "DEBUG") {
    this.name = name;
    this.minLevel = minLevel;
  }

  private log(level: Level, msg: string, data?: unknown): void {
    const idx = LEVELS.indexOf(level);
    if (idx < LEVELS.indexOf(this.minLevel)) return;

    const ts = new Date().toISOString();
    const color = COLORS[level];
    const prefix = `${color}[${ts}] [${level.padEnd(5)}] [${this.name}]${RESET}`;
    const line = data
      ? `${prefix} ${msg} ${JSON.stringify(data)}`
      : `${prefix} ${msg}`;

    if (level === "ERROR") {
      console.error(line);
    } else if (level === "WARN") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  debug(msg: string, data?: unknown): void {
    this.log("DEBUG", msg, data);
  }
  info(msg: string, data?: unknown): void {
    this.log("INFO", msg, data);
  }
  warn(msg: string, data?: unknown): void {
    this.log("WARN", msg, data);
  }
  error(msg: string, data?: unknown): void {
    this.log("ERROR", msg, data);
  }
}
