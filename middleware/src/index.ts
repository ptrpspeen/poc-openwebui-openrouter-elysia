import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { cors } from "@elysiajs/cors";
import { db, webuiDb, initDb } from "./db";
import { redis } from "./redis";
import { Redis } from "ioredis";

const OPENROUTER_BASE = "https://openrouter.ai/api";

const required = [
  "OPENROUTER_API_KEY",
  "ADMIN_API_KEY",
  "OPENROUTER_HTTP_REFERER",
  "OPENROUTER_X_TITLE",
  "LOG_MODE",
] as const;

const missing = required.filter((k) => !process.env[k] || process.env[k]!.trim() === "");
if (missing.length) {
  throw new Error(`Missing required config: ${missing.join(", ")}`);
}

let OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY as string;
let ADMIN_API_KEY = process.env.ADMIN_API_KEY as string;
let OPENROUTER_HTTP_REFERER = process.env.OPENROUTER_HTTP_REFERER as string;
let OPENROUTER_X_TITLE = process.env.OPENROUTER_X_TITLE as string;
let LOG_MODE = process.env.LOG_MODE as string;

const CONFIG_KEYS = [
  "OPENROUTER_API_KEY",
  "ADMIN_API_KEY",
  "OPENROUTER_HTTP_REFERER",
  "OPENROUTER_X_TITLE",
  "LOG_MODE",
  "REDIS_URL",
  "DATABASE_URL",
  "WEBUI_DATABASE_URL",
] as const;
const CONFIG_SYNC_CHANNEL = "middleware:config:updated";
const REQUEST_LOG_SAMPLE_RATE = 0.3;

type SystemLog = { ts: string; level: "info" | "warn" | "error"; message: string; meta?: any };
const SYSTEM_LOG_LIMIT = 500;
const systemLogs: SystemLog[] = [];

function writeSystemLog(level: SystemLog["level"], message: string, meta?: any) {
  systemLogs.unshift({ ts: new Date().toISOString(), level, message, meta });
  if (systemLogs.length > SYSTEM_LOG_LIMIT) systemLogs.pop();
}

function maskConfigValue(key: string, value?: string) {
  if (!value) return "";
  if (key.includes("KEY") || key.includes("PASSWORD") || key.includes("SECRET")) {
    if (value.length <= 8) return "********";
    return `${value.slice(0, 4)}********${value.slice(-4)}`;
  }
  return value;
}

function refreshRuntimeConfig() {
  OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY as string;
  ADMIN_API_KEY = process.env.ADMIN_API_KEY as string;
  OPENROUTER_HTTP_REFERER = process.env.OPENROUTER_HTTP_REFERER as string;
  OPENROUTER_X_TITLE = process.env.OPENROUTER_X_TITLE as string;
  LOG_MODE = process.env.LOG_MODE as string;
}

function validateConfigMap(input: Record<string, string>) {
  const missingRequired = required.filter((k) => !input[k] || input[k].trim() === "");
  if (missingRequired.length) {
    throw new Error(`Missing required config: ${missingRequired.join(", ")}`);
  }
}

async function ensureConfigStore() {
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

async function loadRuntimeConfigFromDb() {
  const rows = await db.all("SELECT key, value FROM system_config WHERE key = ANY($1)", [CONFIG_KEYS]);
  const fromDb: Record<string, string> = {};
  for (const r of rows) fromDb[r.key] = r.value || "";
  validateConfigMap(fromDb);
  for (const key of CONFIG_KEYS) {
    process.env[key] = fromDb[key] || "";
  }
  refreshRuntimeConfig();
}

async function persistConfig(updates: Record<string, string>) {
  for (const [key, value] of Object.entries(updates)) {
    await db.run(
      `INSERT INTO system_config (key, value, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
      [key, value]
    );
  }
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

const STRIP_HEADERS = new Set([
  "cookie", "authorization", "x-forwarded-for", "x-real-ip",
  "x-forwarded-proto", "x-forwarded-host", "accept-encoding", "host", "content-length",
  "x-openwebui-user-email", "x-openwebui-user-id",
]);

function cleanHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (!STRIP_HEADERS.has(lowerKey) && !HOP_BY_HOP_HEADERS.has(lowerKey)) {
      result[key] = value;
    }
  });
  return result;
}

function getBangkokDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error("Failed to derive Bangkok date parts");
  }

  return {
    dayKey: `${year}-${month}-${day}`,
    monthKey: `${year}-${month}`,
  };
}

function parseNumber(value: any, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function usageKeys(userId: string, period: "daily" | "monthly", now = new Date()) {
  const { dayKey, monthKey } = getBangkokDateParts(now);
  const suffix = period === "daily" ? dayKey : monthKey;
  return {
    tokens: `usage:user:${userId}:${period}:${suffix}:tokens`,
    cost: `usage:user:${userId}:${period}:${suffix}:cost`,
  };
}

function parseFormulaConfig(value: any) {
  if (typeof value === "string") {
    try {
      return value.trim() ? JSON.parse(value) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? value : {};
}

function describeLimit(policy: any) {
  return {
    limit_type: policy.limit_type,
    daily_token_limit: parseNumber(policy.daily_token_limit, 0),
    monthly_token_limit: parseNumber(policy.monthly_token_limit, 0),
    daily_cost_limit: parseNumber(policy.daily_cost_limit, 0),
    monthly_cost_limit: parseNumber(policy.monthly_cost_limit, 0),
    formula_kind: policy.formula_kind || null,
    formula_config: parseFormulaConfig(policy.formula_config),
  };
}

function summarizePolicy(policy: any) {
  const type = policy.limit_type || "token";
  const dailyToken = parseNumber(policy.daily_token_limit, 0);
  const monthlyToken = parseNumber(policy.monthly_token_limit, 0);
  const dailyCost = parseNumber(policy.daily_cost_limit, 0);
  const monthlyCost = parseNumber(policy.monthly_cost_limit, 0);
  if (type === "token") return `token d:${dailyToken > 0 ? dailyToken.toLocaleString() : '∞'} / m:${monthlyToken > 0 ? monthlyToken.toLocaleString() : '∞'}`;
  if (type === "cost") return `cost d:${dailyCost > 0 ? `$${dailyCost.toFixed(4)}` : '∞'} / m:${monthlyCost > 0 ? `$${monthlyCost.toFixed(4)}` : '∞'}`;
  return `formula ${policy.formula_kind || "max_ratio"} d:${dailyToken > 0 ? dailyToken.toLocaleString() : '∞'}|${dailyCost > 0 ? `$${dailyCost.toFixed(2)}` : '∞'} m:${monthlyToken > 0 ? monthlyToken.toLocaleString() : '∞'}|${monthlyCost > 0 ? `$${monthlyCost.toFixed(2)}` : '∞'}`;
}

function evaluateWindow(policy: any, usage: { tokens: number; cost: number }, window: "daily" | "monthly") {
  const limitType = policy.limit_type || "token";
  const tokenLimit = parseNumber(policy[`${window}_token_limit`], 0);
  const costLimit = parseNumber(policy[`${window}_cost_limit`], 0);
  const formulaKind = policy.formula_kind || "max_ratio";
  const formulaConfig = parseFormulaConfig(policy.formula_config);
  const tokenRatio = tokenLimit > 0 ? usage.tokens / tokenLimit : 0;
  const costRatio = costLimit > 0 ? usage.cost / costLimit : 0;

  if (limitType === "token") {
    const exceeded = tokenLimit > 0 && usage.tokens >= tokenLimit;
    return { exceeded, reason: exceeded ? `${window} token limit exceeded` : undefined, details: { token_ratio: tokenRatio, remaining_tokens: tokenLimit > 0 ? Math.max(0, tokenLimit - usage.tokens) : null } };
  }

  if (limitType === "cost") {
    const exceeded = costLimit > 0 && usage.cost >= costLimit;
    return { exceeded, reason: exceeded ? `${window} cost limit exceeded` : undefined, details: { cost_ratio: costRatio, remaining_cost: costLimit > 0 ? Math.max(0, costLimit - usage.cost) : null } };
  }

  const threshold = parseNumber(formulaConfig.threshold, 1);
  if (formulaKind === "max_ratio") {
    const score = Math.max(tokenRatio, costRatio);
    const exceeded = score >= threshold;
    return { exceeded, reason: exceeded ? `${window} formula limit exceeded` : undefined, details: { token_ratio: tokenRatio, cost_ratio: costRatio, score, threshold } };
  }

  if (formulaKind === "weighted_ratio") {
    const tokenWeight = parseNumber(formulaConfig.token_weight, 0.5);
    const costWeight = parseNumber(formulaConfig.cost_weight, 0.5);
    const weightTotal = tokenWeight + costWeight;
    const normalizedTokenWeight = weightTotal > 0 ? tokenWeight / weightTotal : 0.5;
    const normalizedCostWeight = weightTotal > 0 ? costWeight / weightTotal : 0.5;
    const score = (tokenRatio * normalizedTokenWeight) + (costRatio * normalizedCostWeight);
    const exceeded = score >= threshold;
    return { exceeded, reason: exceeded ? `${window} formula limit exceeded` : undefined, details: { token_ratio: tokenRatio, cost_ratio: costRatio, score, threshold, token_weight: normalizedTokenWeight, cost_weight: normalizedCostWeight } };
  }

  return { exceeded: false, details: { warning: `Unknown formula kind ${formulaKind}` } };
}

function evaluatePolicyLimit(policy: any, usage: { daily: { tokens: number; cost: number }, monthly: { tokens: number; cost: number } }) {
  const daily = evaluateWindow(policy, usage.daily, "daily");
  if (daily.exceeded) return { allowed: false, reason: daily.reason, details: { daily: daily.details, monthly: null } };
  const monthly = evaluateWindow(policy, usage.monthly, "monthly");
  if (monthly.exceeded) return { allowed: false, reason: monthly.reason, details: { daily: daily.details, monthly: monthly.details } };
  return { allowed: true, details: { daily: daily.details, monthly: monthly.details } };
}

function classifyUpstreamError(status: number, payload: any) {
  const rawMessage = payload?.error?.message || payload?.message || payload?.error || "Upstream request failed";
  const message = String(rawMessage || "Upstream request failed");
  const lower = message.toLowerCase();

  if (status === 401 || status === 403) {
    if (lower.includes("user not found") || lower.includes("invalid api key") || lower.includes("incorrect api key") || lower.includes("unauthorized")) {
      return {
        error: "Upstream API key is invalid or not linked to a valid account",
        code: "UPSTREAM_INVALID_API_KEY",
        upstream: { status, message },
      };
    }
  }

  return {
    error: message,
    code: "UPSTREAM_ERROR",
    upstream: { status, message },
  };
}

function getReportSince(query: any, fallback = "30 days") {
  const range = String(query?.range || "").trim().toLowerCase();
  if (range === "24h" || range === "1d") return "24 hours";
  if (range === "7d" || range === "7days" || range === "week") return "7 days";
  if (range === "30d" || range === "30days" || range === "month") return "30 days";
  if (range === "90d" || range === "90days") return "90 days";
  return fallback;
}

function getLimit(query: any, fallback = 100) {
  const n = Number(query?.limit || fallback);
  return Number.isFinite(n) ? Math.max(1, Math.min(1000, Math.floor(n))) : fallback;
}

function buildSinceDate(query: any, fallback = "30 days") {
  const since = getReportSince(query, fallback);
  return new Date(Date.now() - ({ "24 hours": 24, "7 days": 24*7, "30 days": 24*30, "90 days": 24*90 } as Record<string, number>)[since] * 60 * 60 * 1000).toISOString();
}

function buildPreviousSinceDate(query: any, fallback = "30 days") {
  const since = getReportSince(query, fallback);
  const hours = ({ "24 hours": 24, "7 days": 24 * 7, "30 days": 24 * 30, "90 days": 24 * 90 } as Record<string, number>)[since];
  return {
    currentSince: new Date(Date.now() - hours * 60 * 60 * 1000).toISOString(),
    previousSince: new Date(Date.now() - hours * 2 * 60 * 60 * 1000).toISOString(),
  };
}

function pctChange(current: number, previous: number) {
  if (!previous) return current ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

function normalizePolicyInput(input: any) {
  const limit_type = String(input?.limit_type || "token").trim();
  const scope_period = String(input?.scope_period || "monthly").trim();
  const formula_kind_raw = input?.formula_kind == null || input?.formula_kind === "" ? null : String(input.formula_kind).trim();
  let formula_config = input?.formula_config ?? {};
  if (typeof formula_config === "string") {
    try {
      formula_config = formula_config.trim() ? JSON.parse(formula_config) : {};
    } catch {
      throw new Error("formula_config must be valid JSON");
    }
  }
  if (typeof formula_config !== "object" || Array.isArray(formula_config) || formula_config === null) {
    throw new Error("formula_config must be an object");
  }

  const normalized = {
    id: String(input?.id || "").trim(),
    name: String(input?.name || "").trim(),
    limit_type,
    scope_period,
    daily_token_limit: Math.max(0, parseNumber(input?.daily_token_limit, 0)),
    monthly_token_limit: Math.max(0, parseNumber(input?.monthly_token_limit, 0)),
    daily_cost_limit: Math.max(0, parseNumber(input?.daily_cost_limit, 0)),
    monthly_cost_limit: Math.max(0, parseNumber(input?.monthly_cost_limit, 0)),
    token_limit: Math.max(0, parseNumber(input?.token_limit, 0)),
    cost_limit: Math.max(0, parseNumber(input?.cost_limit, 0)),
    formula_kind: formula_kind_raw,
    formula_config,
    allowed_models: String(input?.allowed_models || "*").trim() || "*",
  };

  if (!normalized.id) throw new Error("Policy id is required");
  if (!normalized.name) throw new Error("Policy name is required");
  if (!LIMIT_TYPES.has(normalized.limit_type)) throw new Error("Invalid limit_type");
  if (!PERIOD_TYPES.has(normalized.scope_period)) throw new Error("Invalid scope_period");

  if (normalized.limit_type === "token") {
    if (normalized.daily_token_limit <= 0 && normalized.monthly_token_limit <= 0) throw new Error("Set daily_token_limit or monthly_token_limit (0 = unlimited for one window, not both)");
    normalized.token_limit = Math.max(normalized.daily_token_limit, normalized.monthly_token_limit, 0);
    normalized.daily_cost_limit = 0;
    normalized.monthly_cost_limit = 0;
    normalized.cost_limit = 0;
    normalized.formula_kind = null;
    normalized.formula_config = {};
  }

  if (normalized.limit_type === "cost") {
    if (normalized.daily_cost_limit <= 0 && normalized.monthly_cost_limit <= 0) throw new Error("Set daily_cost_limit or monthly_cost_limit (0 = unlimited for one window, not both)");
    normalized.cost_limit = Math.max(normalized.daily_cost_limit, normalized.monthly_cost_limit, 0);
    normalized.daily_token_limit = 0;
    normalized.monthly_token_limit = 0;
    normalized.token_limit = 0;
    normalized.formula_kind = null;
    normalized.formula_config = {};
  }

  if (normalized.limit_type === "formula") {
    const formulaKind = normalized.formula_kind || "max_ratio";
    if (!FORMULA_KINDS.has(formulaKind)) throw new Error("Invalid formula_kind");
    const hasDaily = normalized.daily_token_limit > 0 || normalized.daily_cost_limit > 0;
    const hasMonthly = normalized.monthly_token_limit > 0 || normalized.monthly_cost_limit > 0;
    if (!hasDaily && !hasMonthly) throw new Error("Formula policies need at least one daily or monthly threshold");
    normalized.token_limit = Math.max(normalized.daily_token_limit, normalized.monthly_token_limit, 0);
    normalized.cost_limit = Math.max(normalized.daily_cost_limit, normalized.monthly_cost_limit, 0);
    normalized.formula_kind = formulaKind;
    normalized.formula_config = { threshold: 1, ...normalized.formula_config };
    if (formulaKind === "weighted_ratio") {
      normalized.formula_config = { threshold: 1, token_weight: 0.5, cost_weight: 0.5, ...normalized.formula_config };
    }
  }

  return normalized;
}

function getUserFromJWT(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    let payload = parts[1];
    payload += "=".repeat((4 - (payload.length % 4)) % 4);
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const data = JSON.parse(decoded);
    const id = data.email || data.id || data.sub || null;
    return id ? id.toLowerCase() : null;
  } catch { return null; }
}

const USER_CACHE_TTL_MS = 60_000;
const GROUP_CACHE_TTL_MS = 60_000;
const POLICY_CACHE_TTL_MS = 60_000;
const LIMIT_TYPES = new Set(["token", "cost", "formula"]);
const PERIOD_TYPES = new Set(["daily", "monthly"]);
const FORMULA_KINDS = new Set(["max_ratio", "weighted_ratio"]);

const userCache = new Map<string, { value: any; expiresAt: number }>();
const groupCache = new Map<string, { value: string[]; expiresAt: number }>();
const policyCache = new Map<string, { value: any; expiresAt: number }>();

function cacheGet<T>(map: Map<string, { value: T; expiresAt: number }>, key: string): T | null {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet<T>(map: Map<string, { value: T; expiresAt: number }>, key: string, value: T, ttlMs: number) {
  map.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function getUserGroups(userId: string): Promise<string[]> {
    const cached = cacheGet(groupCache, userId);
    if (cached) return cached;

    try {
        const rows = await webuiDb.all(`
            SELECT g.name 
            FROM "user" u 
            JOIN group_member gm ON u.id = gm.user_id 
            JOIN "group" g ON gm.group_id = g.id 
            WHERE u.email = $1 OR u.id = $1
        `, [userId]);
        const groups = rows.map((r: any) => r.name);
        cacheSet(groupCache, userId, groups, GROUP_CACHE_TTL_MS);
        return groups;
    } catch (e) {
        console.error("Failed to fetch user groups:", e);
        return [];
    }
}

async function getUserCached(userId: string) {
  const cached = cacheGet(userCache, userId);
  if (cached) return cached;
  const user = await db.get("SELECT * FROM users WHERE id = $1", [userId]);
  if (user) cacheSet(userCache, userId, user, USER_CACHE_TTL_MS);
  return user;
}

async function getPolicyCached(policyId: string) {
  const cached = cacheGet(policyCache, policyId);
  if (cached) return cached;
  const policy = await db.get("SELECT * FROM policies WHERE id = $1", [policyId]);
  if (policy) cacheSet(policyCache, policyId, policy, POLICY_CACHE_TTL_MS);
  return policy;
}

async function ensureUserExists(userId: string) {
  await db.run("INSERT INTO users (id, policy_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [userId, "default"]);
  const user = await db.get("SELECT * FROM users WHERE id = $1", [userId]);
  if (user) cacheSet(userCache, userId, user, USER_CACHE_TTL_MS);
}

async function resolveEffectivePolicy(user: any, groups: string[]) {
    let effectivePolicyId = user.policy_id;

    // If user is set to 'default', try to upgrade via group policies
    if (effectivePolicyId === 'default' && groups.length > 0) {
        const groupPolicy: any = await db.get(`
            SELECT gp.policy_id 
            FROM group_policies gp
            JOIN policies p ON gp.policy_id = p.id
            WHERE gp.group_name = ANY($1) 
            ORDER BY gp.priority DESC LIMIT 1
        `, [groups]);
        
        if (groupPolicy) {
            effectivePolicyId = groupPolicy.policy_id;
        }
    }
    return effectivePolicyId;
}

async function getUsageSnapshot(userId: string, period: "daily" | "monthly") {
  const keys = usageKeys(userId, period);
  const usageVals = await redis.mget(keys.tokens, keys.cost);
  return {
    tokens: parseNumber(usageVals?.[0], 0),
    cost: parseNumber(usageVals?.[1], 0),
  };
}

async function getUsageSnapshotAll(userId: string) {
  return {
    daily: await getUsageSnapshot(userId, "daily"),
    monthly: await getUsageSnapshot(userId, "monthly"),
  };
}

async function checkAccess(userId: string): Promise<{ allowed: boolean; reason?: string; groups: string[]; policy?: any; usage?: any; details?: any }> {
  const user: any = await getUserCached(userId);
  const groups = await getUserGroups(userId);

  if (!user || !user.is_active) return { allowed: false, reason: "User inactive or not found", groups };

  const activePolicyId = await resolveEffectivePolicy(user, groups);
  const policy: any = await getPolicyCached(activePolicyId);

  if (!policy) return { allowed: false, reason: `Policy ${activePolicyId} not found`, groups };

  const usage = await getUsageSnapshotAll(userId);

  const evaluation = evaluatePolicyLimit(policy, usage);
  return {
    allowed: evaluation.allowed,
    reason: evaluation.reason,
    groups,
    policy: describeLimit(policy),
    usage,
    details: evaluation.details,
  };
}

async function processUsage(userId: string | null, model: string, usage: any) {
  if (!userId) return;
  const dailyKeys = usageKeys(userId, "daily");
  const monthlyKeys = usageKeys(userId, "monthly");
  const total = parseNumber(usage.total_tokens, parseNumber(usage.prompt_tokens, 0) + parseNumber(usage.completion_tokens, 0));
  const cost = parseNumber(usage.cost ?? usage.total_cost ?? 0, 0);

  await Promise.all([
    redis.incrby(dailyKeys.tokens, total),
    redis.incrby(monthlyKeys.tokens, total),
    redis.incrbyfloat(dailyKeys.cost, cost),
    redis.incrbyfloat(monthlyKeys.cost, cost),
    redis.expire(dailyKeys.tokens, 3456000),
    redis.expire(monthlyKeys.tokens, 3456000),
    redis.expire(dailyKeys.cost, 3456000),
    redis.expire(monthlyKeys.cost, 3456000),
    redis.lpush("usage_queue", JSON.stringify({
      user_id: userId, model, prompt_tokens: parseNumber(usage.prompt_tokens, 0),
      completion_tokens: parseNumber(usage.completion_tokens, 0), total_tokens: total,
      total_cost: cost, ts: new Date().toISOString()
    }))
  ]);
}

async function getSystemHealth() {
  const out: any = { status: "ok", ts: new Date().toISOString(), checks: {} };
  try {
    await db.run("SELECT 1");
    out.checks.database = { ok: true };
  } catch (e: any) {
    out.status = "degraded";
    out.checks.database = { ok: false, error: e?.message || String(e) };
  }

  try {
    await webuiDb.run ? await (webuiDb as any).run("SELECT 1") : await webuiDb.get("SELECT 1 as ok");
    out.checks.webui_database = { ok: true };
  } catch (e: any) {
    out.status = "degraded";
    out.checks.webui_database = { ok: false, error: e?.message || String(e) };
  }

  try {
    const pong = await redis.ping();
    const queueLength = await redis.llen("usage_queue");
    out.checks.redis = { ok: pong === "PONG", queueLength };
  } catch (e: any) {
    out.status = "degraded";
    out.checks.redis = { ok: false, error: e?.message || String(e) };
  }

  return out;
}

async function startConfigSubscriber() {
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
}

async function drainQueue(queue: string, batchSize = 50): Promise<any[]> {
  const items: any[] = [];
  for (let i = 0; i < batchSize; i++) {
    const item = await redis.rpop(queue);
    if (!item) break;
    items.push(JSON.parse(item));
  }
  return items;
}

async function startBackgroundWorker() {
  console.log("👷 Background Worker started");
  while (true) {
    try {
      const usageBatch = await drainQueue("usage_queue", 100);
      for (const data of usageBatch) {
        await db.run(
          "INSERT INTO usage_logs (user_id, model, prompt_tokens, completion_tokens, total_tokens, total_cost, ts) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [data.user_id, data.model, data.prompt_tokens, data.completion_tokens, data.total_tokens, data.total_cost, data.ts]
        );
      }

      const perfBatch = await drainQueue("request_perf_queue", 100);
      for (const p of perfBatch) {
        await db.run(
          `INSERT INTO request_logs (user_id, model, path, method, status, is_stream, latency_ms, total_cost, denied_reason, denied_category, started_at, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [p.user_id, p.model, p.path, p.method, p.status, p.is_stream, p.latency_ms, p.total_cost || 0, p.denied_reason || null, p.denied_category || null, p.started_at, p.completed_at]
        );
      }

      if (usageBatch.length === 0 && perfBatch.length === 0) {
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e: any) {
      console.error("Worker Error:", e);
      writeSystemLog("error", "Background worker error", { error: e?.message || String(e) });
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

function cleanResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lowerKey) && lowerKey !== "content-length" && lowerKey !== "content-encoding") {
      result[key] = value;
    }
  });
  return result;
}

function logRequestPerformance(args: {
  userId: string | null;
  model: string;
  path: string;
  method: string;
  status: number;
  isStream: boolean;
  startedAt: Date;
  completedAt: Date;
  totalCost?: number;
  deniedReason?: string | null;
  deniedCategory?: string | null;
}) {
  if (Math.random() > REQUEST_LOG_SAMPLE_RATE) return;

  const latencyMs = Math.max(0, args.completedAt.getTime() - args.startedAt.getTime());
  const payload = {
    user_id: args.userId,
    model: args.model,
    path: args.path,
    method: args.method,
    status: args.status,
    is_stream: args.isStream,
    latency_ms: latencyMs,
    total_cost: Number(args.totalCost || 0),
    denied_reason: args.deniedReason || null,
    denied_category: args.deniedCategory || null,
    started_at: args.startedAt.toISOString(),
    completed_at: args.completedAt.toISOString(),
  };
  redis.lpush("request_perf_queue", JSON.stringify(payload)).catch((e) => {
    writeSystemLog("error", "Failed to enqueue request performance", { error: e?.message || String(e) });
  });
}

async function* streamWithUsageTracking(response: Response, userId: string | null): AsyncGenerator<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
      try {
        const text = decoder.decode(value, { stream: true });
        buffer += text;
        while (buffer.includes("\n\n")) {
          const idx = buffer.indexOf("\n\n");
          const part = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (part.startsWith("data: ")) {
            const dataStr = part.slice(6).trim();
            if (dataStr && dataStr !== "[DONE]") {
              try {
                const data = JSON.parse(dataStr);
                if (data.usage) await processUsage(userId, data.model || "", data.usage);
              } catch { }
            }
          }
        }
      } catch { }
    }
  } finally { reader.releaseLock(); }
}

const app = new Elysia()
  .use(cors())
  .use(staticPlugin())
  .all("/v1/*", async ({ request, params, set }) => {
    const requestStartedAt = new Date();
    if (!OPENROUTER_API_KEY) { set.status = 500; return "OPENROUTER_API_KEY not set"; }
    const path = (params as { "*": string })["*"];
    
    if (path === "models" && request.method === "GET") {
        const upstreamResponse = await fetch(`${OPENROUTER_BASE}/v1/models`, {
            headers: { "Authorization": `Bearer ${OPENROUTER_API_KEY}`, "Accept": "application/json" }
        });
        const completedAt = new Date();
        logRequestPerformance({
          userId: null,
          model: "models",
          path,
          method: request.method,
          status: upstreamResponse.status,
          isStream: false,
          startedAt: requestStartedAt,
          completedAt,
          totalCost: 0,
        });
        return new Response(await upstreamResponse.arrayBuffer(), { 
            status: upstreamResponse.status, 
            headers: cleanResponseHeaders(upstreamResponse.headers) 
        });
    }

    const upstreamUrl = `${OPENROUTER_BASE}/v1/${path}`;
    let rawUserId = request.headers.get("x-openwebui-user-email") || request.headers.get("x-openwebui-user-id");
    let userId: string | null = rawUserId ? rawUserId.toLowerCase().trim() : null;

    if (!userId) {
      const authHeader = request.headers.get("authorization") || "";
      if (authHeader.startsWith("Bearer ")) userId = getUserFromJWT(authHeader.split(" ")[1]);
    }

    if (userId) await ensureUserExists(userId);

    let body: any = null;
    let modelName = "unknown";
    if (request.method === "POST" && request.headers.get("content-type")?.includes("application/json")) {
      body = await request.json();
      modelName = body.model || "unknown";
      if (userId) {
        const access = await checkAccess(userId);
        if (!access.allowed) {
          const deniedReason = access.reason || "Quota exceeded";
          const deniedCategory = deniedReason.toLowerCase().includes('daily token') ? 'daily_token' :
            deniedReason.toLowerCase().includes('monthly token') ? 'monthly_token' :
            deniedReason.toLowerCase().includes('daily cost') ? 'daily_cost' :
            deniedReason.toLowerCase().includes('monthly cost') ? 'monthly_cost' :
            deniedReason.toLowerCase().includes('formula') ? 'formula' : 'quota';
          logRequestPerformance({
            userId,
            model: body.model || '',
            path,
            method: request.method,
            status: 403,
            isStream: Boolean(body.stream),
            startedAt: requestStartedAt,
            completedAt: new Date(),
            totalCost: 0,
            deniedReason,
            deniedCategory,
          });
          set.status = 403;
          return {
            error: deniedReason,
            policy: access.policy,
            usage: access.usage,
            details: access.details,
            groups: access.groups,
          };
        }
      }
    }

    const headers = cleanHeaders(request.headers);
    headers["Authorization"] = `Bearer ${OPENROUTER_API_KEY}`;
    headers["User-Agent"] = request.headers.get("user-agent") || "OpenWebUI-Middleware/1.0";
    if (OPENROUTER_HTTP_REFERER) headers["HTTP-Referer"] = OPENROUTER_HTTP_REFERER;
    if (OPENROUTER_X_TITLE) headers["X-Title"] = OPENROUTER_X_TITLE;

    const url = new URL(upstreamUrl);
    new URL(request.url).searchParams.forEach((v, k) => url.searchParams.set(k, v));

    const upstreamResponse = await fetch(url.toString(), {
      method: request.method, headers,
      body: body ? JSON.stringify(body) : (request.method === "GET" ? null : await request.arrayBuffer()),
    });

    let upstreamJsonError: any = null;
    if (!upstreamResponse.ok) {
      try {
        upstreamJsonError = await upstreamResponse.clone().json();
      } catch {
        upstreamJsonError = null;
      }
      writeSystemLog("warn", "Upstream returned non-2xx", {
        status: upstreamResponse.status,
        path,
        userId,
        upstreamMessage: upstreamJsonError?.error?.message || upstreamJsonError?.message || null,
      });
    }

    const responseHeaders = cleanResponseHeaders(upstreamResponse.headers);

    if (upstreamResponse.headers.get("content-type")?.includes("text/event-stream")) {
      const stream = new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of streamWithUsageTracking(upstreamResponse, userId)) controller.enqueue(chunk);
            controller.close();
          } finally {
            const completedAt = new Date();
            logRequestPerformance({
              userId,
              model: modelName,
              path,
              method: request.method,
              status: upstreamResponse.status,
              isStream: true,
              startedAt: requestStartedAt,
              completedAt,
              totalCost: 0,
            });
          }
        },
      });
      return new Response(stream, { status: upstreamResponse.status, headers: responseHeaders });
    } else {
      const respData = upstreamJsonError ?? await upstreamResponse.json();
      const completedAt = new Date();
      logRequestPerformance({
        userId,
        model: respData.model || modelName,
        path,
        method: request.method,
        status: upstreamResponse.status,
        isStream: false,
        startedAt: requestStartedAt,
        completedAt,
        totalCost: Number(respData?.usage?.cost || respData?.usage?.total_cost || 0),
      });

      if (!upstreamResponse.ok) {
        const mappedError = classifyUpstreamError(upstreamResponse.status, respData);
        return new Response(JSON.stringify(mappedError), { status: upstreamResponse.status, headers: responseHeaders });
      }

      if (respData.usage) await processUsage(userId, respData.model || modelName, respData.usage);
      return new Response(JSON.stringify(respData), { status: upstreamResponse.status, headers: responseHeaders });
    }
  })
  .get("/health", () => ({ status: "ok", engine: "elysia", storage: "hybrid" }))
  .group("/admin", (app) =>
    app
      .onBeforeHandle(({ request, set }) => {
        const auth = request.headers.get("x-admin-key");
        if (auth !== ADMIN_API_KEY) { set.status = 401; return "Unauthorized"; }
      })
      .get("/users", async () => {
        const users = await db.all("SELECT * FROM users ORDER BY created_at DESC");
        const results = [];
        for (const user of users) {
            const groups = await getUserGroups(user.id);
            const effectivePolicyId = await resolveEffectivePolicy(user, groups);
            const effectivePolicy = await getPolicyCached(effectivePolicyId);
            const usageSummary = effectivePolicy ? await getUsageSnapshotAll(user.id) : null;
            const evaluation = effectivePolicy && usageSummary ? evaluatePolicyLimit(effectivePolicy, usageSummary) : null;
            results.push({
              ...user,
              groups,
              effective_policy_id: effectivePolicyId,
              effective_policy_summary: effectivePolicy ? summarizePolicy(effectivePolicy) : null,
              effective_limit_type: effectivePolicy?.limit_type || null,
              effective_usage: usageSummary,
              effective_usage_details: evaluation?.details || null,
            });
        }
        return results;
      })
      .get("/policies", () => db.all("SELECT * FROM policies ORDER BY created_at DESC"))
      .get("/usage", () => db.all("SELECT * FROM usage_logs ORDER BY ts DESC LIMIT 100"))
      .get("/group-policies", () => db.all("SELECT * FROM group_policies ORDER BY priority DESC, group_name ASC"))
      .get("/openwebui-groups", async ({ set }) => {
        try {
          const rows = await webuiDb.all('SELECT name FROM "group" ORDER BY name ASC');
          return rows;
        } catch (e: any) {
          writeSystemLog("error", "Failed to load OpenWebUI groups", { error: e?.message || String(e) });
          set.status = 500;
          return { error: "Failed to load OpenWebUI groups" };
        }
      })
      .post("/group-policies", async ({ body }: any) => {
        const { group_name, policy_id, priority } = body;
        await db.run(
          "INSERT INTO group_policies (group_name, policy_id, priority) VALUES ($1, $2, $3) ON CONFLICT(group_name) DO UPDATE SET policy_id=excluded.policy_id, priority=excluded.priority",
          [group_name, policy_id, priority || 0]
        );
        return { success: true };
      })
      .delete("/group-policies/:name", async ({ params }) => {
        await db.run("DELETE FROM group_policies WHERE group_name = $1", [params.name]);
        return { success: true };
      })
      .patch("/users/:id", async ({ params, body }: any) => {
        const { is_active, policy_id } = body;
        if (is_active !== undefined) {
          await db.run("UPDATE users SET is_active = $1 WHERE id = $2", [is_active ? 1 : 0, params.id]);
        }
        if (policy_id !== undefined) {
          await db.run("UPDATE users SET policy_id = $1 WHERE id = $2", [policy_id, params.id]);
        }
        userCache.delete(params.id);
        return { success: true };
      })
      .post("/policies", async ({ body, set }: any) => {
        let policy;
        try {
          policy = normalizePolicyInput(body);
        } catch (e: any) {
          set.status = 400;
          return { success: false, error: e?.message || String(e) };
        }

        const legacyDaily = policy.daily_token_limit;
        const legacyMonthly = policy.monthly_token_limit;

        await db.run(
          `INSERT INTO policies (
            id, name, daily_token_limit, monthly_token_limit, allowed_models,
            limit_type, scope_period, token_limit, cost_limit, formula_kind, formula_config,
            daily_cost_limit, monthly_cost_limit
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            daily_token_limit=excluded.daily_token_limit,
            monthly_token_limit=excluded.monthly_token_limit,
            allowed_models=excluded.allowed_models,
            limit_type=excluded.limit_type,
            scope_period=excluded.scope_period,
            token_limit=excluded.token_limit,
            cost_limit=excluded.cost_limit,
            formula_kind=excluded.formula_kind,
            formula_config=excluded.formula_config,
            daily_cost_limit=excluded.daily_cost_limit,
            monthly_cost_limit=excluded.monthly_cost_limit`,
          [
            policy.id,
            policy.name,
            legacyDaily,
            legacyMonthly,
            policy.allowed_models,
            policy.limit_type,
            policy.scope_period,
            policy.token_limit,
            policy.cost_limit,
            policy.formula_kind,
            JSON.stringify(policy.formula_config || {}),
            policy.daily_cost_limit,
            policy.monthly_cost_limit,
          ]
        );
        policyCache.delete(policy.id);
        return { success: true };
      })
      .post("/policies/preview", async ({ body, set }: any) => {
        let policy;
        try {
          policy = normalizePolicyInput({
            id: body?.policy?.id || "preview",
            name: body?.policy?.name || "Preview Policy",
            ...body?.policy,
          });
        } catch (e: any) {
          set.status = 400;
          return { success: false, error: e?.message || String(e) };
        }

        const usage = {
          daily: {
            tokens: parseNumber(body?.usage?.daily?.tokens ?? body?.usage?.tokens, 0),
            cost: parseNumber(body?.usage?.daily?.cost ?? body?.usage?.cost, 0),
          },
          monthly: {
            tokens: parseNumber(body?.usage?.monthly?.tokens ?? body?.usage?.tokens, 0),
            cost: parseNumber(body?.usage?.monthly?.cost ?? body?.usage?.cost, 0),
          },
        };
        const evaluation = evaluatePolicyLimit(policy, usage);
        return {
          success: true,
          allowed: evaluation.allowed,
          reason: evaluation.reason || null,
          policy: describeLimit(policy),
          usage,
          details: evaluation.details,
        };
      })
      .delete("/policies/:id", async ({ params }) => {
        if (params.id === 'default') return { success: false, error: "Cannot delete default policy" };
        await db.run("DELETE FROM policies WHERE id = $1", [params.id]);
        policyCache.delete(params.id);
        return { success: true };
      })
      .get("/stats", async () => {
          const totalUsers = await db.get("SELECT COUNT(*) as count FROM users");
          const totalPolicies = await db.get("SELECT COUNT(*) as count FROM policies");
          const overallUsage = await db.get("SELECT SUM(total_tokens) as tokens, SUM(total_cost) as cost, COUNT(*) as reqs FROM usage_logs");
          const topModels = await db.all("SELECT model, COUNT(*) as count, SUM(total_tokens) as tokens FROM usage_logs GROUP BY model ORDER BY count DESC LIMIT 5");
          const topUsers = await db.all("SELECT user_id, SUM(total_tokens) as tokens, SUM(total_cost) as cost FROM usage_logs GROUP BY user_id ORDER BY tokens DESC LIMIT 5");
          
          const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const last24h = await db.get("SELECT SUM(total_tokens) as tokens, SUM(total_cost) as cost FROM usage_logs WHERE ts >= $1", [yesterday]);
          const perf = await db.get(`
            SELECT
              COUNT(*)::int AS requests,
              COALESCE(AVG(latency_ms), 0)::float AS avg_latency_ms,
              COALESCE(MAX(latency_ms), 0)::int AS max_latency_ms,
              COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::float AS p95_latency_ms
            FROM request_logs
            WHERE started_at >= $1
          `, [yesterday]);

          return {
              total_users: parseInt(totalUsers.count),
              total_policies: parseInt(totalPolicies.count),
              total_tokens: parseInt(overallUsage.tokens || "0"),
              total_cost: parseFloat(overallUsage.cost || "0"),
              total_requests: parseInt(overallUsage.reqs || "0"),
              last_24h: {
                  tokens: parseInt(last24h.tokens || "0"),
                  cost: parseFloat(last24h.cost || "0"),
                  requests: perf?.requests || 0,
                  avg_latency_ms: Number(perf?.avg_latency_ms || 0),
                  p95_latency_ms: Number(perf?.p95_latency_ms || 0),
                  max_latency_ms: Number(perf?.max_latency_ms || 0)
              },
              top_models: topModels,
              top_users: topUsers
          };
      })
      .get("/reports/summary", async ({ query }: any) => {
        const { currentSince, previousSince } = buildPreviousSinceDate(query, "30 days");
        const since = currentSince;
        const summary = await db.get(`
          SELECT
            COUNT(*)::int AS total_requests,
            COUNT(DISTINCT user_id)::int AS active_users,
            COUNT(DISTINCT model)::int AS active_models,
            COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
            COALESCE(SUM(total_cost), 0)::float AS total_cost,
            COALESCE(AVG(total_tokens), 0)::float AS avg_tokens_per_request,
            COALESCE(AVG(total_cost), 0)::float AS avg_cost_per_request
          FROM usage_logs
          WHERE ts >= $1
        `, [since]);

        const blocked = await db.get(`
          SELECT COUNT(*)::int AS blocked_requests
          FROM request_logs
          WHERE started_at >= $1 AND status = 403
        `, [since]);

        const topModels = await db.all(`
          SELECT model, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost
          FROM usage_logs
          WHERE ts >= $1
          GROUP BY model
          ORDER BY cost DESC, requests DESC
          LIMIT 10
        `, [since]);

        const topUsers = await db.all(`
          SELECT user_id, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost
          FROM usage_logs
          WHERE ts >= $1
          GROUP BY user_id
          ORDER BY cost DESC, tokens DESC
          LIMIT 10
        `, [since]);

        const previousUsage = await db.get(`
          SELECT COUNT(*)::int AS total_requests, COALESCE(SUM(total_tokens),0)::bigint AS total_tokens, COALESCE(SUM(total_cost),0)::float AS total_cost
          FROM usage_logs
          WHERE ts >= $1 AND ts < $2
        `, [previousSince, currentSince]);
        const previousBlocked = await db.get(`
          SELECT COUNT(*)::int AS blocked_requests
          FROM request_logs
          WHERE started_at >= $1 AND started_at < $2 AND status = 403
        `, [previousSince, currentSince]);

        const topGroup = (await (async () => {
          const usageByUser = await db.all(`SELECT user_id, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost FROM usage_logs WHERE ts >= $1 GROUP BY user_id`, [since]);
          const groupMap = new Map<string, number>();
          for (const row of usageByUser) {
            const groups = await getUserGroups(row.user_id);
            for (const g of (groups.length ? groups : ['[ungrouped]'])) groupMap.set(g, (groupMap.get(g) || 0) + Number(row.cost || 0));
          }
          const [name, cost] = [...groupMap.entries()].sort((a,b)=>b[1]-a[1])[0] || ['-',0];
          return { group_name: name, cost };
        })());

        return {
          range: getReportSince(query, "30 days"),
          since,
          summary: { ...summary, blocked_requests: Number(blocked?.blocked_requests || 0) },
          comparison: {
            requests_pct: pctChange(Number(summary?.total_requests || 0), Number(previousUsage?.total_requests || 0)),
            tokens_pct: pctChange(Number(summary?.total_tokens || 0), Number(previousUsage?.total_tokens || 0)),
            cost_pct: pctChange(Number(summary?.total_cost || 0), Number(previousUsage?.total_cost || 0)),
            blocked_pct: pctChange(Number(blocked?.blocked_requests || 0), Number(previousBlocked?.blocked_requests || 0)),
            previous: { ...previousUsage, blocked_requests: Number(previousBlocked?.blocked_requests || 0) }
          },
          executive: {
            top_spender: topUsers[0] || null,
            most_expensive_model: topModels[0] || null,
            most_active_group: topGroup
          },
          top_models: topModels,
          top_users: topUsers
        };
      })
      .get("/reports/users", async ({ query }: any) => {
        const since = buildSinceDate(query, "30 days");
        const limit = getLimit(query, 100);
        const rows = await db.all(`
          SELECT user_id, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost,
                 COALESCE(MAX(ts), NOW()) AS last_seen
          FROM usage_logs
          WHERE ts >= $1
          GROUP BY user_id
          ORDER BY cost DESC, tokens DESC
          LIMIT ${limit}
        `, [since]);

        const out = [];
        for (const row of rows) {
          const user: any = await getUserCached(row.user_id);
          const groups = await getUserGroups(row.user_id);
          const effectivePolicyId = user ? await resolveEffectivePolicy(user, groups) : null;
          out.push({ ...row, groups, effective_policy_id: effectivePolicyId, is_active: user?.is_active ?? null, assigned_policy_id: user?.policy_id ?? null });
        }
        return { range: getReportSince(query, "30 days"), since, rows: out };
      })
      .get("/reports/groups", async ({ query }: any) => {
        const since = buildSinceDate(query, "30 days");
        const usageByUser = await db.all(`
          SELECT user_id, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost
          FROM usage_logs
          WHERE ts >= $1
          GROUP BY user_id
        `, [since]);

        const groupMap = new Map<string, { group_name: string; active_users: number; requests: number; tokens: number; cost: number }>();
        for (const row of usageByUser) {
          const groups = await getUserGroups(row.user_id);
          const targets = groups.length ? groups : ["[ungrouped]"];
          for (const groupName of targets) {
            const current = groupMap.get(groupName) || { group_name: groupName, active_users: 0, requests: 0, tokens: 0, cost: 0 };
            current.active_users += 1;
            current.requests += Number(row.requests || 0);
            current.tokens += Number(row.tokens || 0);
            current.cost += Number(row.cost || 0);
            groupMap.set(groupName, current);
          }
        }

        const rows = [...groupMap.values()].sort((a, b) => (b.cost - a.cost) || (b.tokens - a.tokens));
        return { range: getReportSince(query, "30 days"), since, rows };
      })
      .get("/reports/costs", async ({ query }: any) => {
        const since = buildSinceDate(query, "30 days");
        const byDay = await db.all(`
          SELECT DATE(ts) AS day, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost
          FROM usage_logs
          WHERE ts >= $1
          GROUP BY DATE(ts)
          ORDER BY day DESC
        `, [since]);
        const byModel = await db.all(`
          SELECT model, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost
          FROM usage_logs
          WHERE ts >= $1
          GROUP BY model
          ORDER BY cost DESC, requests DESC
        `, [since]);
        return { range: getReportSince(query, "30 days"), since, by_day: byDay, by_model: byModel };
      })
      .get("/reports/quota-events", async ({ query }: any) => {
        const since = buildSinceDate(query, "30 days");
        const limit = getLimit(query, 200);
        const rows = await db.all(`
          SELECT id, user_id, model, path, method, status, total_cost, denied_reason, denied_category, started_at, completed_at
          FROM request_logs
          WHERE started_at >= $1 AND status = 403
          ORDER BY id DESC
          LIMIT ${limit}
        `, [since]);
        const breakdown = await db.all(`
          SELECT COALESCE(denied_category, 'quota') AS category, COUNT(*)::int AS count
          FROM request_logs
          WHERE started_at >= $1 AND status = 403
          GROUP BY COALESCE(denied_category, 'quota')
          ORDER BY count DESC
        `, [since]);
        return { range: getReportSince(query, "30 days"), since, rows, breakdown };
      })
      .get("/reports/user/:id", async ({ params, query }: any) => {
        const since = buildSinceDate(query, "30 days");
        const userId = params.id;
        const summary = await db.get(`SELECT user_id, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost, COALESCE(MAX(ts), NOW()) AS last_seen FROM usage_logs WHERE user_id = $1 AND ts >= $2 GROUP BY user_id`, [userId, since]);
        const byDay = await db.all(`SELECT DATE(ts) AS day, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost FROM usage_logs WHERE user_id = $1 AND ts >= $2 GROUP BY DATE(ts) ORDER BY day DESC`, [userId, since]);
        const byModel = await db.all(`SELECT model, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost FROM usage_logs WHERE user_id = $1 AND ts >= $2 GROUP BY model ORDER BY cost DESC, tokens DESC`, [userId, since]);
        const events = await db.all(`SELECT id, denied_category, denied_reason, started_at, path, status FROM request_logs WHERE user_id = $1 AND started_at >= $2 AND status = 403 ORDER BY id DESC LIMIT 100`, [userId, since]);
        const groups = await getUserGroups(userId);
        return { id: userId, since, summary: summary || { user_id: userId, requests: 0, tokens: 0, cost: 0 }, groups, by_day: byDay, by_model: byModel, quota_events: events };
      })
      .get("/reports/group/:name", async ({ params, query }: any) => {
        const since = buildSinceDate(query, "30 days");
        const groupName = decodeURIComponent(params.name);
        const userRows = await db.all(`SELECT user_id, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost FROM usage_logs WHERE ts >= $1 GROUP BY user_id`, [since]);
        const members = [];
        for (const row of userRows) {
          const groups = await getUserGroups(row.user_id);
          if (groups.includes(groupName)) members.push(row);
        }
        const summary = members.reduce((acc, row) => ({ requests: acc.requests + Number(row.requests||0), tokens: acc.tokens + Number(row.tokens||0), cost: acc.cost + Number(row.cost||0), active_users: acc.active_users + 1 }), { requests: 0, tokens: 0, cost: 0, active_users: 0 });
        return { name: groupName, since, summary, members };
      })
      .get("/reports/model/:name", async ({ params, query }: any) => {
        const since = buildSinceDate(query, "30 days");
        const model = decodeURIComponent(params.name);
        const summary = await db.get(`SELECT model, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost FROM usage_logs WHERE model = $1 AND ts >= $2 GROUP BY model`, [model, since]);
        const byUser = await db.all(`SELECT user_id, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost FROM usage_logs WHERE model = $1 AND ts >= $2 GROUP BY user_id ORDER BY cost DESC, tokens DESC`, [model, since]);
        const byDay = await db.all(`SELECT DATE(ts) AS day, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost FROM usage_logs WHERE model = $1 AND ts >= $2 GROUP BY DATE(ts) ORDER BY day DESC`, [model, since]);
        return { name: model, since, summary: summary || { model, requests: 0, tokens: 0, cost: 0 }, by_user: byUser, by_day: byDay };
      })
      .get("/performance", async ({ query }: any) => {
        const q = query || {};
        const where: string[] = ["started_at >= NOW() - INTERVAL '24 hours'"];
        const params: any[] = [];

        if (q.user_id) {
          params.push(`%${q.user_id}%`);
          where.push(`user_id ILIKE $${params.length}`);
        }
        if (q.model) {
          params.push(`%${q.model}%`);
          where.push(`model ILIKE $${params.length}`);
        }
        if (q.path) {
          params.push(`%${q.path}%`);
          where.push(`path ILIKE $${params.length}`);
        }
        if (q.status) {
          params.push(Number(q.status));
          where.push(`status = $${params.length}`);
        }

        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

        const summary = await db.get(`
          SELECT
            COUNT(*)::int AS requests,
            COALESCE(AVG(latency_ms), 0)::float AS avg_latency_ms,
            COALESCE(MAX(latency_ms), 0)::int AS max_latency_ms,
            COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY latency_ms), 0)::float AS p50_latency_ms,
            COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::float AS p95_latency_ms,
            COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms), 0)::float AS p99_latency_ms,
            COALESCE(SUM(total_cost), 0)::float AS total_cost,
            COALESCE(AVG(total_cost), 0)::float AS avg_cost
          FROM request_logs
          ${whereSql}
        `, params);

        const recent = await db.all(`
          SELECT id, user_id, model, path, method, status, is_stream, latency_ms, total_cost, started_at, completed_at
          FROM request_logs
          ${whereSql}
          ORDER BY id DESC
          LIMIT 200
        `, params);

        return { summary, recent, sample_rate: REQUEST_LOG_SAMPLE_RATE };
      })
      .get("/config", async () => {
        const rows = await db.all("SELECT key, value, updated_at FROM system_config WHERE key = ANY($1)", [CONFIG_KEYS]);
        const config: Record<string, string> = {};
        const masked: Record<string, string> = {};
        let updatedAt: string | null = null;
        for (const row of rows) {
          config[row.key] = row.value || "";
          masked[row.key] = maskConfigValue(row.key, row.value);
          if (!updatedAt || new Date(row.updated_at).getTime() > new Date(updatedAt).getTime()) {
            updatedAt = row.updated_at;
          }
        }
        return { config, masked, updatedAt };
      })
      .post("/config", async ({ body, set }: any) => {
        const updates = body?.config || {};
        const changed: string[] = [];

        const currentRows = await db.all("SELECT key, value FROM system_config WHERE key = ANY($1)", [CONFIG_KEYS]);
        const merged: Record<string, string> = {};
        for (const row of currentRows) merged[row.key] = row.value || "";

        for (const key of Object.keys(updates)) {
          if ((CONFIG_KEYS as readonly string[]).includes(key)) {
            merged[key] = String(updates[key] ?? "");
            changed.push(key);
          }
        }

        try {
          validateConfigMap(merged);
        } catch (e: any) {
          set.status = 400;
          return { success: false, error: e?.message || String(e) };
        }

        await persistConfig(merged);
        await loadRuntimeConfigFromDb();
        await redis.publish(CONFIG_SYNC_CHANNEL, JSON.stringify({ changed, ts: new Date().toISOString() }));

        writeSystemLog("info", "Config updated via admin API", { changed });
        return { success: true, changed };
      })
      .get("/health", async () => await getSystemHealth())
      .get("/system-logs", () => ({ logs: systemLogs }))
  )
  .get("/", () => Bun.file("public/index.html"))
  .get("/js/admin.js", () => Bun.file("public/js/admin.js"))
  .get("/js/reports.js", () => Bun.file("public/js/reports.js"))
  .listen(8080);

console.log(`🦊 AI Control Plane running at http://localhost:${app.server?.port}`);
writeSystemLog("info", "Middleware started", { port: app.server?.port });
await initDb();
await ensureConfigStore();
await loadRuntimeConfigFromDb();
await startConfigSubscriber();
startBackgroundWorker();
