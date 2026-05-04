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
  "VIRTUAL_MODELS_JSON",
  "VIRTUAL_ROUTER_CONFIG_JSON",
] as const;

export const CONFIG_SYNC_CHANNEL = "middleware:config:updated";

const CONFIG_DEFAULTS: Partial<Record<(typeof CONFIG_KEYS)[number], string>> = {
  VIRTUAL_MODELS_JSON: JSON.stringify([
    {
      id: "virtual/auto-fast",
      name: "Auto Fast",
      description: "Lowest-cost routing for lightweight chat, rewrite, and summary tasks.",
      strategy: "cheap_first",
      candidates: ["google/gemini-2.5-flash", "openai/gpt-4o-mini", "anthropic/claude-3.5-haiku"],
    },
    {
      id: "virtual/auto-balanced",
      name: "Auto Balanced",
      description: "Balanced routing for most everyday coding and analysis tasks.",
      strategy: "balanced",
      candidates: ["openai/gpt-4.1-mini", "google/gemini-2.5-flash", "anthropic/claude-3.7-sonnet"],
    },
    {
      id: "virtual/auto-best",
      name: "Auto Best",
      description: "Premium routing for hard reasoning, architecture, and security-sensitive tasks.",
      strategy: "premium",
      candidates: ["anthropic/claude-opus-4", "openai/gpt-5", "google/gemini-2.5-pro"],
    },
    {
      id: "virtual/auto-code",
      name: "Auto Code",
      description: "Routing tuned for code generation, debugging, and technical analysis.",
      strategy: "code",
      candidates: ["anthropic/claude-3.7-sonnet", "openai/gpt-4.1", "google/gemini-2.5-pro"],
    },
    {
      id: "virtual/auto-long",
      name: "Auto Long Context",
      description: "Routing for long-context requests and document-heavy prompts.",
      strategy: "long_context",
      candidates: ["google/gemini-2.5-pro", "openai/gpt-4.1", "anthropic/claude-3.7-sonnet"],
    },
  ]),
  VIRTUAL_ROUTER_CONFIG_JSON: JSON.stringify({
    premium_model_ids: ["virtual/auto-best"],
    premium_allowed_groups: ["admin", "research"],
    premium_daily_cost_limit: 0,
    premium_monthly_cost_limit: 0,
  }),
};

function getConfigDefault(key: (typeof CONFIG_KEYS)[number]) {
  return process.env[key] || CONFIG_DEFAULTS[key] || "";
}

// ─── Mutable runtime config ───────────────────────────────────────────────────
// Import this object everywhere instead of reading process.env directly at
// call-time, so that hot-reload via Redis pub/sub takes effect immediately.

export const runtimeConfig = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
  ADMIN_API_KEY: process.env.ADMIN_API_KEY || "",
  OPENROUTER_HTTP_REFERER: process.env.OPENROUTER_HTTP_REFERER || "",
  OPENROUTER_X_TITLE: process.env.OPENROUTER_X_TITLE || "",
  LOG_MODE: process.env.LOG_MODE || "",
  VIRTUAL_MODELS_JSON: getConfigDefault("VIRTUAL_MODELS_JSON"),
  VIRTUAL_ROUTER_CONFIG_JSON: getConfigDefault("VIRTUAL_ROUTER_CONFIG_JSON"),
};

export function isSensitiveConfigKey(key: string) {
  return key.includes("KEY") || key.includes("PASSWORD") || key.includes("SECRET");
}

export function refreshRuntimeConfig() {
  runtimeConfig.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
  runtimeConfig.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";
  runtimeConfig.OPENROUTER_HTTP_REFERER = process.env.OPENROUTER_HTTP_REFERER || "";
  runtimeConfig.OPENROUTER_X_TITLE = process.env.OPENROUTER_X_TITLE || "";
  runtimeConfig.LOG_MODE = process.env.LOG_MODE || "";
  runtimeConfig.VIRTUAL_MODELS_JSON = getConfigDefault("VIRTUAL_MODELS_JSON");
  runtimeConfig.VIRTUAL_ROUTER_CONFIG_JSON = getConfigDefault("VIRTUAL_ROUTER_CONFIG_JSON");
}

export function maskConfigValue(key: string, value?: string) {
  if (!value) return "";
  if (isSensitiveConfigKey(key)) {
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
    const value = getConfigDefault(key);
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
