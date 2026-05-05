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
  "VIRTUAL_ROUTER_RULES_JSON",
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
    hybrid_classifier_enabled: false,
    hybrid_classifier_model: "openai/gpt-4.1-nano",
    hybrid_confidence_threshold: 0.55,
    hybrid_classifier_timeout_ms: 1000,
    hybrid_classifier_cache_ttl_ms: 300000,
  }),
  VIRTUAL_ROUTER_RULES_JSON: JSON.stringify({
    premium_keyword_score: 2,
    long_context_tokens: 8000,
    premium_prompt_tokens: 4000,
    signal_rules: [
      { label: "architecture", description: "Architecture/design/tradeoff tasks", weight: 1, coding: false, keywords: ["architecture", "design", "system design", "tradeoff", "migration", "สถาปัตยกรรม", "ออกแบบระบบ", "ออกแบบ", "โครงสร้างระบบ", "ย้ายระบบ", "ไมเกรต", "ข้อดีข้อเสีย", "เปรียบเทียบทางเลือก"] },
      { label: "security", description: "Security/auth/vulnerability tasks", weight: 1, coding: false, keywords: ["security", "vulnerability", "threat", "auth", "authorization", "encryption", "ความปลอดภัย", "ช่องโหว่", "ภัยคุกคาม", "ยืนยันตัวตน", "สิทธิ์", "เข้ารหัส", "แฮก", "โจมตี"] },
      { label: "root_cause_debug", description: "Incident/debug/root-cause tasks", weight: 1, coding: false, keywords: ["root cause", "incident", "postmortem", "debug", "diagnose", "failure", "สาเหตุ", "ต้นเหตุ", "หาสาเหตุ", "วิเคราะห์ปัญหา", "ดีบัก", "บั๊ก", "แก้บั๊ก", "ระบบล่ม", "ล้มเหลว", "ใช้งานไม่ได้"] },
      { label: "analysis_research", description: "Analysis/comparison/research tasks", weight: 1, coding: false, keywords: ["analyze", "analyse", "compare", "evaluate", "reason", "research", "วิเคราะห์", "เปรียบเทียบ", "ประเมิน", "ให้เหตุผล", "วิจัย", "สรุปเชิงลึก", "อธิบายเหตุผล"] },
      { label: "coding", description: "Programming/API/database/frontend/backend tasks", weight: 0, coding: true, keywords: ["code", "bug", "fix", "refactor", "typescript", "javascript", "sql", "query", "api", "backend", "frontend", "โค้ด", "เขียนโปรแกรม", "โปรแกรม", "แก้โค้ด", "รีแฟกเตอร์", "ฐานข้อมูล", "คิวรี่", "เอพีไอ", "หน้าบ้าน", "หลังบ้าน", "ฟรอนต์เอนด์", "แบ็กเอนด์"] },
    ],
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
  VIRTUAL_ROUTER_RULES_JSON: getConfigDefault("VIRTUAL_ROUTER_RULES_JSON"),
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
  runtimeConfig.VIRTUAL_ROUTER_RULES_JSON = getConfigDefault("VIRTUAL_ROUTER_RULES_JSON");
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

  validateVirtualModelsJson(input.VIRTUAL_MODELS_JSON || "");
  validateVirtualRouterConfigJson(input.VIRTUAL_ROUTER_CONFIG_JSON || "");
  validateVirtualRouterRulesJson(input.VIRTUAL_ROUTER_RULES_JSON || "");
}

function parseJsonConfigValue(raw: string, key: string) {
  if (!raw || !raw.trim()) return null;
  try { return JSON.parse(raw); } catch (e: any) { throw new Error(`${key} is invalid JSON: ${e?.message || String(e)}`); }
}

function validateVirtualModelsJson(raw: string) {
  const parsed = parseJsonConfigValue(raw, "VIRTUAL_MODELS_JSON");
  if (parsed == null) return;
  if (!Array.isArray(parsed)) throw new Error("VIRTUAL_MODELS_JSON must be an array");
  if (!parsed.length) throw new Error("VIRTUAL_MODELS_JSON must contain at least one virtual model");
  const seen = new Set<string>();
  const strategies = new Set(["cheap_first", "balanced", "premium", "code", "long_context"]);
  parsed.forEach((model: any, index: number) => {
    const label = model?.id || `model #${index + 1}`;
    const id = String(model?.id || "").trim();
    if (!id) throw new Error(`${label}: id is required`);
    if (seen.has(id)) throw new Error(`${id}: duplicate virtual model id`);
    seen.add(id);
    if (!String(model?.name || "").trim()) throw new Error(`${label}: name is required`);
    if (!String(model?.description || "").trim()) throw new Error(`${label}: description is required`);
    if (!strategies.has(String(model?.strategy || "").trim())) throw new Error(`${label}: invalid strategy`);
    if (!Array.isArray(model?.candidates) || model.candidates.map((v: any) => String(v || "").trim()).filter(Boolean).length === 0) {
      throw new Error(`${label}: add at least one candidate model`);
    }
  });
}

function validateVirtualRouterConfigJson(raw: string) {
  const parsed = parseJsonConfigValue(raw, "VIRTUAL_ROUTER_CONFIG_JSON");
  if (parsed == null) return;
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("VIRTUAL_ROUTER_CONFIG_JSON must be an object");
  for (const key of ["premium_model_ids", "premium_allowed_groups"]) {
    if (parsed[key] != null && !Array.isArray(parsed[key])) throw new Error(`${key} must be an array`);
  }
  for (const key of ["premium_daily_cost_limit", "premium_monthly_cost_limit"]) {
    const value = Number(parsed[key] || 0);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a non-negative number`);
  }
  if (parsed.hybrid_classifier_enabled != null && typeof parsed.hybrid_classifier_enabled !== "boolean") {
    throw new Error("hybrid_classifier_enabled must be a boolean");
  }
  if (parsed.hybrid_classifier_model != null && !String(parsed.hybrid_classifier_model || "").trim()) {
    throw new Error("hybrid_classifier_model must not be empty");
  }
  if (parsed.hybrid_confidence_threshold != null) {
    const value = Number(parsed.hybrid_confidence_threshold);
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("hybrid_confidence_threshold must be between 0 and 1");
  }
  for (const key of ["hybrid_classifier_timeout_ms", "hybrid_classifier_cache_ttl_ms"]) {
    if (parsed[key] != null) {
      const value = Number(parsed[key]);
      if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a non-negative number`);
    }
  }
}

function validateVirtualRouterRulesJson(raw: string) {
  const parsed = parseJsonConfigValue(raw, "VIRTUAL_ROUTER_RULES_JSON");
  if (parsed == null) return;
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("VIRTUAL_ROUTER_RULES_JSON must be an object");
  for (const key of ["premium_keyword_score", "long_context_tokens", "premium_prompt_tokens"]) {
    const value = Number(parsed[key]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a non-negative number`);
  }
  if (!Array.isArray(parsed.signal_rules) || parsed.signal_rules.length === 0) throw new Error("signal_rules must be a non-empty array");
  const seen = new Set<string>();
  parsed.signal_rules.forEach((rule: any, index: number) => {
    const label = String(rule?.label || "").trim();
    if (!label) throw new Error(`signal rule #${index + 1}: label is required`);
    if (seen.has(label)) throw new Error(`${label}: duplicate signal rule label`);
    seen.add(label);
    if (!Array.isArray(rule?.keywords) || rule.keywords.map((v: any) => String(v || "").trim()).filter(Boolean).length === 0) throw new Error(`${label}: add at least one keyword`);
    const weight = Number(rule?.weight);
    if (!Number.isFinite(weight) || weight < 0) throw new Error(`${label}: weight must be a non-negative number`);
    if (rule?.coding != null && typeof rule.coding !== "boolean") throw new Error(`${label}: coding must be boolean`);
  });
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
