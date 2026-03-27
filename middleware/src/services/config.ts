import { db } from "../db";
import { Redis } from "ioredis";

// ─── System logs ──────────────────────────────────────────────────────────────

type SystemLog = { ts: string; level: "info" | "warn" | "error"; message: string; meta?: any };
const SYSTEM_LOG_LIMIT = 500;
export const systemLogs: SystemLog[] = [];

export function writeSystemLog(level: SystemLog["level"], message: string, meta?: any) {
  systemLogs.unshift({ ts: new Date().toISOString(), level, message, meta });
  if (systemLogs.length > SYSTEM_LOG_LIMIT) systemLogs.pop();
}

// ─── Config keys & required set ───────────────────────────────────────────────

export const required = [
  "OPENROUTER_API_KEY",
  "ADMIN_API_KEY",
  "OPENROUTER_HTTP_REFERER",
  "OPENROUTER_X_TITLE",
  "LOG_MODE",
] as const;

export const CONFIG_KEYS = [
  "OPENROUTER_API_KEY",
  "ADMIN_API_KEY",
  "OPENROUTER_HTTP_REFERER",
  "OPENROUTER_X_TITLE",
  "LOG_MODE",
  "REDIS_URL",
  "DATABASE_URL",
  "WEBUI_DATABASE_URL",
] as const;

export const CONFIG_SYNC_CHANNEL = "middleware:config:updated";

// ─── Mutable runtime config ───────────────────────────────────────────────────
// Import this object everywhere instead of reading process.env directly at
// call-time, so that hot-reload via Redis pub/sub takes effect immediately.

export const runtimeConfig = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
  ADMIN_API_KEY: process.env.ADMIN_API_KEY || "",
  OPENROUTER_HTTP_REFERER: process.env.OPENROUTER_HTTP_REFERER || "",
  OPENROUTER_X_TITLE: process.env.OPENROUTER_X_TITLE || "",
  LOG_MODE: process.env.LOG_MODE || "",
};

export function refreshRuntimeConfig() {
  runtimeConfig.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
  runtimeConfig.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";
  runtimeConfig.OPENROUTER_HTTP_REFERER = process.env.OPENROUTER_HTTP_REFERER || "";
  runtimeConfig.OPENROUTER_X_TITLE = process.env.OPENROUTER_X_TITLE || "";
  runtimeConfig.LOG_MODE = process.env.LOG_MODE || "";
}

export function maskConfigValue(key: string, value?: string) {
  if (!value) return "";
  if (key.includes("KEY") || key.includes("PASSWORD") || key.includes("SECRET")) {
    if (value.length <= 8) return "********";
    return `${value.slice(0, 4)}********${value.slice(-4)}`;
  }
  return value;
}

export function validateConfigMap(input: Record<string, string>) {
  const missingRequired = required.filter((k) => !input[k] || input[k].trim() === "");
  if (missingRequired.length) {
    throw new Error(`Missing required config: ${missingRequired.join(", ")}`);
  }
}

// ─── Config persistence ───────────────────────────────────────────────────────

export async function ensureConfigStore() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS system_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  for (const key of CONFIG_KEYS) {
    const value = process.env[key] || "";
    await db.run(
      "INSERT INTO system_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
      [key, value]
    );
  }
}

export async function loadRuntimeConfigFromDb() {
  const rows = await db.all("SELECT key, value FROM system_config WHERE key = ANY($1)", [CONFIG_KEYS]);
  const fromDb: Record<string, string> = {};
  for (const r of rows) fromDb[r.key] = r.value || "";
  validateConfigMap(fromDb);
  for (const key of CONFIG_KEYS) {
    process.env[key] = fromDb[key] || "";
  }
  refreshRuntimeConfig();
}

export async function persistConfig(updates: Record<string, string>) {
  for (const [key, value] of Object.entries(updates)) {
    await db.run(
      `INSERT INTO system_config (key, value, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
      [key, value]
    );
  }
}

// ─── Redis pub/sub config subscriber ─────────────────────────────────────────

export async function startConfigSubscriber(): Promise<Redis> {
  const subscriber = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null });
  await subscriber.subscribe(CONFIG_SYNC_CHANNEL);
  subscriber.on("message", async (channel, message) => {
    if (channel !== CONFIG_SYNC_CHANNEL) return;
    try {
      await loadRuntimeConfigFromDb();
      writeSystemLog("info", "Config reloaded from pub/sub", { message });
    } catch (e: any) {
      writeSystemLog("error", "Config reload failed", { error: e?.message || String(e) });
    }
  });
  return subscriber;
}
