import { db, webuiDb } from "../db";
import { redis } from "../redis";
import { writeSystemLog } from "./config";

// ─── Constants ────────────────────────────────────────────────────────────────

export const LIMIT_TYPES = new Set(["token", "cost", "formula"]);
export const PERIOD_TYPES = new Set(["daily", "monthly"]);
export const FORMULA_KINDS = new Set(["max_ratio", "weighted_ratio"]);
export const REQUEST_LOG_SAMPLE_RATE = 0.3;

// ─── Generic helpers ──────────────────────────────────────────────────────────

export function parseNumber(value: any, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function parseFormulaConfig(value: any) {
  if (typeof value === "string") {
    try {
      return value.trim() ? JSON.parse(value) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? value : {};
}

export function getBangkokDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;

  if (!year || !month || !day) throw new Error("Failed to derive Bangkok date parts");
  return { dayKey: `${year}-${month}-${day}`, monthKey: `${year}-${month}` };
}

export function usageKeys(userId: string, period: "daily" | "monthly", now = new Date()) {
  const { dayKey, monthKey } = getBangkokDateParts(now);
  const suffix = period === "daily" ? dayKey : monthKey;
  return {
    tokens: `usage:user:${userId}:${period}:${suffix}:tokens`,
    cost: `usage:user:${userId}:${period}:${suffix}:cost`,
  };
}

// ─── Policy description ───────────────────────────────────────────────────────

export function describeLimit(policy: any) {
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

export function summarizePolicy(policy: any) {
  const type = policy.limit_type || "token";
  const dailyToken = parseNumber(policy.daily_token_limit, 0);
  const monthlyToken = parseNumber(policy.monthly_token_limit, 0);
  const dailyCost = parseNumber(policy.daily_cost_limit, 0);
  const monthlyCost = parseNumber(policy.monthly_cost_limit, 0);
  if (type === "token") return `token d:${dailyToken > 0 ? dailyToken.toLocaleString() : "∞"} / m:${monthlyToken > 0 ? monthlyToken.toLocaleString() : "∞"}`;
  if (type === "cost") return `cost d:${dailyCost > 0 ? `$${dailyCost.toFixed(4)}` : "∞"} / m:${monthlyCost > 0 ? `$${monthlyCost.toFixed(4)}` : "∞"}`;
  return `formula ${policy.formula_kind || "max_ratio"} d:${dailyToken > 0 ? dailyToken.toLocaleString() : "∞"}|${dailyCost > 0 ? `$${dailyCost.toFixed(2)}` : "∞"} m:${monthlyToken > 0 ? monthlyToken.toLocaleString() : "∞"}|${monthlyCost > 0 ? `$${monthlyCost.toFixed(2)}` : "∞"}`;
}

// ─── Policy evaluation ────────────────────────────────────────────────────────

export function evaluateWindow(policy: any, usage: { tokens: number; cost: number }, window: "daily" | "monthly") {
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
    const score = tokenRatio * normalizedTokenWeight + costRatio * normalizedCostWeight;
    const exceeded = score >= threshold;
    return { exceeded, reason: exceeded ? `${window} formula limit exceeded` : undefined, details: { token_ratio: tokenRatio, cost_ratio: costRatio, score, threshold, token_weight: normalizedTokenWeight, cost_weight: normalizedCostWeight } };
  }

  // Unknown formula kind — fail closed (block request) rather than silently allowing it.
  console.warn(`[quota] Unknown formula_kind '${formulaKind}' — blocking request to prevent misconfiguration from being treated as unlimited`);
  writeSystemLog("warn", `Unknown formula_kind '${formulaKind}' in policy — request blocked`, { window });
  return {
    exceeded: true,
    reason: `${window} formula limit exceeded (unknown formula_kind: ${formulaKind})`,
    details: { warning: `Unknown formula_kind: ${formulaKind}` },
  };
}

export function evaluatePolicyLimit(policy: any, usage: { daily: { tokens: number; cost: number }; monthly: { tokens: number; cost: number } }) {
  const daily = evaluateWindow(policy, usage.daily, "daily");
  if (daily.exceeded) return { allowed: false, reason: daily.reason, details: { daily: daily.details, monthly: null } };
  const monthly = evaluateWindow(policy, usage.monthly, "monthly");
  if (monthly.exceeded) return { allowed: false, reason: monthly.reason, details: { daily: daily.details, monthly: monthly.details } };
  return { allowed: true, details: { daily: daily.details, monthly: monthly.details } };
}

// ─── Policy normalization ─────────────────────────────────────────────────────

export function normalizePolicyInput(input: any) {
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

// ─── JWT verification (fix: HS256 signature checked via Web Crypto API) ───────
//
// WEBUI_SECRET_KEY is optional. If provided, incoming Bearer JWTs are verified
// cryptographically. If omitted, JWT-based auth is disabled and only the
// x-openwebui-user-email / x-openwebui-user-id headers (set by OpenWebUI
// within the Docker network) are accepted.

const WEBUI_SECRET_KEY = process.env.WEBUI_SECRET_KEY || "";
if (!WEBUI_SECRET_KEY) {
  console.warn("[auth] WEBUI_SECRET_KEY not set — JWT Bearer auth is disabled. Only x-openwebui-* headers accepted.");
}

let _cachedJwtKey: CryptoKey | null = null;

async function getJwtKey(): Promise<CryptoKey | null> {
  if (!WEBUI_SECRET_KEY) return null;
  if (_cachedJwtKey) return _cachedJwtKey;
  _cachedJwtKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBUI_SECRET_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  return _cachedJwtKey;
}

export async function getUserFromJWT(token: string): Promise<string | null> {
  try {
    const key = await getJwtKey();
    if (!key) return null; // JWT auth is disabled — WEBUI_SECRET_KEY not configured

    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const sigInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sigBase64 = parts[2].replace(/-/g, "+").replace(/_/g, "/");
    const sigPadded = sigBase64 + "=".repeat((4 - (sigBase64.length % 4)) % 4);
    const sigBytes = Uint8Array.from(atob(sigPadded), (c) => c.charCodeAt(0));

    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, sigInput);
    if (!valid) {
      console.warn("[auth] JWT signature verification failed — token rejected");
      return null;
    }

    let payload = parts[1];
    payload += "=".repeat((4 - (payload.length % 4)) % 4);
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));

    if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) return null; // expired

    const id = decoded.email || decoded.id || decoded.sub || null;
    return id ? String(id).toLowerCase() : null;
  } catch {
    return null;
  }
}

// ─── In-memory caches ────────────────────────────────────────────────────────

const USER_CACHE_TTL_MS = 60_000;
const GROUP_CACHE_TTL_MS = 60_000;
const POLICY_CACHE_TTL_MS = 60_000;

const userCache = new Map<string, { value: any; expiresAt: number }>();
const groupCache = new Map<string, { value: string[]; expiresAt: number }>();
const policyCache = new Map<string, { value: any; expiresAt: number }>();

function cacheGet<T>(map: Map<string, { value: T; expiresAt: number }>, key: string): T | null {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { map.delete(key); return null; }
  return hit.value;
}

function cacheSet<T>(map: Map<string, { value: T; expiresAt: number }>, key: string, value: T, ttlMs: number) {
  map.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function invalidateUserCache(userId: string) { userCache.delete(userId); }
export function invalidatePolicyCache(policyId: string) { policyCache.delete(policyId); }

// ─── DB helpers ───────────────────────────────────────────────────────────────

export async function getUserGroups(userId: string): Promise<string[]> {
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

export async function getUserCached(userId: string) {
  const cached = cacheGet(userCache, userId);
  if (cached) return cached;
  const user = await db.get("SELECT * FROM users WHERE id = $1", [userId]);
  if (user) cacheSet(userCache, userId, user, USER_CACHE_TTL_MS);
  return user;
}

export async function getPolicyCached(policyId: string) {
  const cached = cacheGet(policyCache, policyId);
  if (cached) return cached;
  const policy = await db.get("SELECT * FROM policies WHERE id = $1", [policyId]);
  if (policy) cacheSet(policyCache, policyId, policy, POLICY_CACHE_TTL_MS);
  return policy;
}

export async function ensureUserExists(userId: string) {
  await db.run("INSERT INTO users (id, policy_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [userId, "default"]);
  const user = await db.get("SELECT * FROM users WHERE id = $1", [userId]);
  if (user) cacheSet(userCache, userId, user, USER_CACHE_TTL_MS);
}

export async function resolveEffectivePolicy(user: any, groups: string[]) {
  let effectivePolicyId = user.policy_id;
  if (effectivePolicyId === "default" && groups.length > 0) {
    const groupPolicy: any = await db.get(`
      SELECT gp.policy_id
      FROM group_policies gp
      JOIN policies p ON gp.policy_id = p.id
      WHERE gp.group_name = ANY($1)
      ORDER BY gp.priority DESC LIMIT 1
    `, [groups]);
    if (groupPolicy) effectivePolicyId = groupPolicy.policy_id;
  }
  return effectivePolicyId;
}

// ─── Usage tracking ───────────────────────────────────────────────────────────

export async function getUsageSnapshot(userId: string, period: "daily" | "monthly") {
  const keys = usageKeys(userId, period);
  const usageVals = await redis.mget(keys.tokens, keys.cost);
  return { tokens: parseNumber(usageVals?.[0], 0), cost: parseNumber(usageVals?.[1], 0) };
}

export async function getUsageSnapshotAll(userId: string) {
  return {
    daily: await getUsageSnapshot(userId, "daily"),
    monthly: await getUsageSnapshot(userId, "monthly"),
  };
}

export async function checkAccess(userId: string): Promise<{ allowed: boolean; reason?: string; groups: string[]; policy?: any; usage?: any; details?: any }> {
  const user: any = await getUserCached(userId);
  const groups = await getUserGroups(userId);
  if (!user || !user.is_active) return { allowed: false, reason: "User inactive or not found", groups };
  const activePolicyId = await resolveEffectivePolicy(user, groups);
  const policy: any = await getPolicyCached(activePolicyId);
  if (!policy) return { allowed: false, reason: `Policy ${activePolicyId} not found`, groups };
  const usage = await getUsageSnapshotAll(userId);
  const evaluation = evaluatePolicyLimit(policy, usage);
  return { allowed: evaluation.allowed, reason: evaluation.reason, groups, policy: describeLimit(policy), usage, details: evaluation.details };
}

export async function processUsage(userId: string | null, model: string, usage: any) {
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
      user_id: userId, model,
      prompt_tokens: parseNumber(usage.prompt_tokens, 0),
      completion_tokens: parseNumber(usage.completion_tokens, 0),
      total_tokens: total, total_cost: cost,
      ts: new Date().toISOString(),
    })),
  ]);
}

// ─── Request performance logging ──────────────────────────────────────────────

export function logRequestPerformance(args: {
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

// ─── Streaming with usage tracking ───────────────────────────────────────────

export async function* streamWithUsageTracking(response: Response, userId: string | null): AsyncGenerator<Uint8Array> {
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
              } catch (e) {
                console.debug("[stream] Failed to parse SSE chunk:", e);
              }
            }
          }
        }
      } catch { }
    }
  } finally {
    reader.releaseLock();
  }
}
