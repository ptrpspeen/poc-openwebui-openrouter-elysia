import { db, webuiDb } from "../db";
import { redis } from "../redis";
import { writeSystemLog } from "./config";

// ─── Constants ────────────────────────────────────────────────────────────────

export const LIMIT_TYPES = new Set(["token", "cost", "formula"]);
export const PERIOD_TYPES = new Set(["daily", "monthly"]);
export const FORMULA_KINDS = new Set(["max_ratio", "weighted_ratio"]);
export const REQUEST_LOG_SAMPLE_RATE = 0.3;
const USAGE_KEY_TTL_SECONDS = 40 * 24 * 60 * 60;
const DEFAULT_COMPLETION_RESERVATION_TOKENS = 1024;
const MODEL_PRICING_CACHE_TTL_MS = 15 * 60 * 1000;
const HISTORICAL_RATE_CACHE_TTL_MS = 10 * 60 * 1000;
const COST_RESERVATION_SAFETY_MULTIPLIER = 1.15;
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

type ModelPricingRecord = {
  id: string;
  pricing?: {
    prompt?: string;
    completion?: string;
    web_search?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
  top_provider?: {
    max_completion_tokens?: number | null;
  };
};

let modelPricingCache: { expiresAt: number; byId: Map<string, ModelPricingRecord> } | null = null;
const historicalRateCache = new Map<string, { expiresAt: number; costPerToken: number }>();

function modelLookupCandidates(modelName: string) {
  const raw = String(modelName || "").trim();
  const candidates = new Set<string>([raw]);
  if (!raw) return [];

  const segments = raw.split(":");
  while (segments.length > 1) {
    segments.pop();
    candidates.add(segments.join(":"));
  }

  candidates.add(raw.replace(/:online$/i, ""));
  return [...candidates].filter(Boolean);
}

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

export function reservationKeys(userId: string, period: "daily" | "monthly", now = new Date()) {
  const { dayKey, monthKey } = getBangkokDateParts(now);
  const suffix = period === "daily" ? dayKey : monthKey;
  return {
    tokens: `usage:user:${userId}:${period}:${suffix}:reserved:tokens`,
    cost: `usage:user:${userId}:${period}:${suffix}:reserved:cost`,
  };
}

// ─── Policy description ───────────────────────────────────────────────────────

export function describeLimit(policy: any) {
  return {
    limit_type: policy.limit_type,
    allowed_models: String(policy.allowed_models || "*"),
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

function splitAllowedModels(input: string) {
  return input
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function modelPatternToRegex(pattern: string) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function isModelAllowed(policy: any, modelName?: string | null) {
  const allowedModels = String(policy?.allowed_models || "*").trim();
  if (!allowedModels || allowedModels === "*") return true;
  if (!modelName) return false;
  const candidates = splitAllowedModels(allowedModels);
  if (candidates.length === 0) return true;
  return candidates.some((pattern) => modelPatternToRegex(pattern).test(modelName));
}

function extractTextForReservation(input: any): string[] {
  if (input == null) return [];
  if (typeof input === "string") return [input];
  if (typeof input === "number" || typeof input === "boolean") return [String(input)];
  if (Array.isArray(input)) return input.flatMap((item) => extractTextForReservation(item));
  if (typeof input === "object") {
    return Object.entries(input).flatMap(([key, value]) => {
      if (["image_url", "audio", "video", "file", "tool_calls", "tools"].includes(key)) return [];
      return extractTextForReservation(value);
    });
  }
  return [];
}

export function estimatePromptTokensFromRequestBody(body: any) {
  const joined = extractTextForReservation({
    prompt: body?.prompt,
    input: body?.input,
    messages: body?.messages,
  }).join("\n");
  if (!joined.trim()) return 0;
  return Math.max(1, Math.ceil(joined.length / 4));
}

export function estimateUsageFromRequestBody(body: any) {
  const promptTokens = estimatePromptTokensFromRequestBody(body);
  const requestedCompletionTokens = Math.max(
    0,
    parseNumber(body?.max_tokens, 0),
    parseNumber(body?.max_completion_tokens, 0),
    parseNumber(body?.max_output_tokens, 0),
  );
  const completionTokens = requestedCompletionTokens > 0
    ? requestedCompletionTokens
    : Math.max(DEFAULT_COMPLETION_RESERVATION_TOKENS, promptTokens);

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    total_cost: 0,
  };
}

export function calculateEstimatedCostFromPricing(
  pricing: { prompt?: string | number; completion?: string | number } | null | undefined,
  usage: { prompt_tokens: number; completion_tokens: number }
) {
  const promptRate = Math.max(0, parseNumber(pricing?.prompt, 0));
  const completionRate = Math.max(0, parseNumber(pricing?.completion, 0));
  const raw = usage.prompt_tokens * promptRate + usage.completion_tokens * completionRate;
  return raw > 0 ? raw * COST_RESERVATION_SAFETY_MULTIPLIER : 0;
}

function hasExplicitCacheControl(input: any): boolean {
  if (input == null) return false;
  if (Array.isArray(input)) return input.some((item) => hasExplicitCacheControl(item));
  if (typeof input === "object") {
    if (input.cache_control) return true;
    return Object.values(input).some((value) => hasExplicitCacheControl(value));
  }
  return false;
}

function estimateCacheWriteTokens(body: any, promptTokens: number) {
  if (!promptTokens) return 0;
  if (body?.cache_control) return promptTokens;
  return hasExplicitCacheControl(body?.messages) ? promptTokens : 0;
}

function hasWebSearchEnabled(modelName: string, body: any) {
  if (String(modelName || "").includes(":online")) return true;
  if (Array.isArray(body?.plugins) && body.plugins.some((plugin: any) => plugin?.id === "web")) return true;
  if (body?.web_search_options) return true;
  if (Array.isArray(body?.tools) && body.tools.some((tool: any) => {
    const name = tool?.function?.name || tool?.name || tool?.id || tool?.type;
    return ["web_search", "openrouter:web_search", "x_search"].includes(String(name || ""));
  })) return true;
  return false;
}

function estimateWebSearchCost(modelName: string, body: any, pricing: ModelPricingRecord["pricing"]) {
  if (!hasWebSearchEnabled(modelName, body)) return 0;

  const configuredPlugin = Array.isArray(body?.plugins)
    ? body.plugins.find((plugin: any) => plugin?.id === "web")
    : null;
  const engine = String(configuredPlugin?.engine || "").toLowerCase();
  const maxResults = Math.max(1, Math.trunc(parseNumber(configuredPlugin?.max_results, 5)));
  const catalogCharge = Math.max(0, parseNumber(pricing?.web_search, 0));

  if (engine === "exa" || engine === "parallel") {
    return Math.max(catalogCharge, maxResults * 0.004);
  }

  if (engine === "firecrawl") {
    return 0;
  }

  return catalogCharge;
}

async function loadModelPricingCatalog(force = false) {
  if (!force && modelPricingCache && modelPricingCache.expiresAt > Date.now()) {
    return modelPricingCache.byId;
  }

  const response = await fetch(OPENROUTER_MODELS_URL, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Failed to load model pricing catalog (${response.status})`);
  const payload: any = await response.json();
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const byId = new Map<string, ModelPricingRecord>();
  for (const row of rows) {
    if (row?.id) byId.set(String(row.id), row as ModelPricingRecord);
    if (row?.canonical_slug) byId.set(String(row.canonical_slug), row as ModelPricingRecord);
  }
  modelPricingCache = { expiresAt: Date.now() + MODEL_PRICING_CACHE_TTL_MS, byId };
  return byId;
}

async function getHistoricalCostPerToken(modelName: string) {
  const cached = historicalRateCache.get(modelName);
  if (cached && cached.expiresAt > Date.now()) return cached.costPerToken;

  const row: any = await db.get(
    `SELECT
       COALESCE(SUM(total_cost), 0)::float AS total_cost,
       COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens
     FROM usage_logs
     WHERE model = $1`,
    [modelName]
  );

  const totalCost = Math.max(0, parseNumber(row?.total_cost, 0));
  const totalTokens = Math.max(0, parseNumber(row?.total_tokens, 0));
  const costPerToken = totalTokens > 0 ? totalCost / totalTokens : 0;
  historicalRateCache.set(modelName, { expiresAt: Date.now() + HISTORICAL_RATE_CACHE_TTL_MS, costPerToken });
  return costPerToken;
}

export async function estimateReservedUsage(modelName: string, body: any) {
  const usage = estimateUsageFromRequestBody(body);
  let estimatedCost = 0;

  try {
    const catalog = await loadModelPricingCatalog();
    const record = modelLookupCandidates(modelName)
      .map((candidate) => catalog.get(candidate))
      .find(Boolean);
    const promptRate = Math.max(0, parseNumber(record?.pricing?.prompt, 0));
    const cacheWriteRate = Math.max(0, parseNumber(record?.pricing?.input_cache_write, 0));
    const providerMax = Math.max(0, parseNumber(record?.top_provider?.max_completion_tokens, 0));
    if (providerMax > 0 && usage.completion_tokens > providerMax) {
      usage.completion_tokens = providerMax;
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    }
    estimatedCost = calculateEstimatedCostFromPricing(record?.pricing, usage);
    const cacheWriteTokens = estimateCacheWriteTokens(body, usage.prompt_tokens);
    const cacheWriteSurcharge = Math.max(0, cacheWriteRate - promptRate) * cacheWriteTokens;
    const webSearchCost = estimateWebSearchCost(modelName, body, record?.pricing);
    estimatedCost += (cacheWriteSurcharge + webSearchCost) * COST_RESERVATION_SAFETY_MULTIPLIER;
  } catch (e: any) {
    writeSystemLog("warn", "Failed to fetch model pricing catalog for reservation", {
      model: modelName,
      error: e?.message || String(e),
    });
  }

  if (estimatedCost <= 0) {
    const historicalRate = await getHistoricalCostPerToken(modelName);
    if (historicalRate > 0) {
      estimatedCost = usage.total_tokens * historicalRate * COST_RESERVATION_SAFETY_MULTIPLIER;
    }
  }

  return {
    ...usage,
    total_cost: estimatedCost,
  };
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

export async function getUsageSnapshot(userId: string, period: "daily" | "monthly", includeReservations = false) {
  const keys = usageKeys(userId, period);
  const reserved = reservationKeys(userId, period);
  const lookupKeys = includeReservations
    ? [keys.tokens, keys.cost, reserved.tokens, reserved.cost]
    : [keys.tokens, keys.cost];
  const usageVals = await redis.mget(...lookupKeys);
  const actualTokens = parseNumber(usageVals?.[0], 0);
  const actualCost = parseNumber(usageVals?.[1], 0);
  const reservedTokens = includeReservations ? parseNumber(usageVals?.[2], 0) : 0;
  const reservedCost = includeReservations ? parseNumber(usageVals?.[3], 0) : 0;
  return {
    tokens: actualTokens + reservedTokens,
    cost: actualCost + reservedCost,
    actual_tokens: actualTokens,
    actual_cost: actualCost,
    reserved_tokens: reservedTokens,
    reserved_cost: reservedCost,
  };
}

export async function getUsageSnapshotAll(userId: string, includeReservations = false) {
  return {
    daily: await getUsageSnapshot(userId, "daily", includeReservations),
    monthly: await getUsageSnapshot(userId, "monthly", includeReservations),
  };
}

export async function checkAccess(userId: string, modelName?: string | null): Promise<{ allowed: boolean; reason?: string; groups: string[]; policy?: any; usage?: any; details?: any }> {
  const user: any = await getUserCached(userId);
  const groups = await getUserGroups(userId);
  if (!user || !user.is_active) return { allowed: false, reason: "User inactive or not found", groups };
  const activePolicyId = await resolveEffectivePolicy(user, groups);
  const policy: any = await getPolicyCached(activePolicyId);
  if (!policy) return { allowed: false, reason: `Policy ${activePolicyId} not found`, groups };
  if (!isModelAllowed(policy, modelName)) {
    return {
      allowed: false,
      reason: `Model '${modelName || "unknown"}' is not allowed by policy`,
      groups,
      policy: describeLimit(policy),
    };
  }
  const usage = await getUsageSnapshotAll(userId, true);
  const evaluation = evaluatePolicyLimit(policy, usage);
  return { allowed: evaluation.allowed, reason: evaluation.reason, groups, policy: describeLimit(policy), usage, details: evaluation.details };
}

export async function reserveUsageEstimate(userId: string, usage: { total_tokens: number; total_cost: number }, now = new Date()) {
  const daily = reservationKeys(userId, "daily", now);
  const monthly = reservationKeys(userId, "monthly", now);
  const totalTokens = Math.max(0, Math.trunc(parseNumber(usage.total_tokens, 0)));
  const totalCost = Math.max(0, parseNumber(usage.total_cost, 0));

  await redis.multi()
    .incrby(daily.tokens, totalTokens)
    .incrby(monthly.tokens, totalTokens)
    .incrbyfloat(daily.cost, totalCost)
    .incrbyfloat(monthly.cost, totalCost)
    .expire(daily.tokens, USAGE_KEY_TTL_SECONDS)
    .expire(monthly.tokens, USAGE_KEY_TTL_SECONDS)
    .expire(daily.cost, USAGE_KEY_TTL_SECONDS)
    .expire(monthly.cost, USAGE_KEY_TTL_SECONDS)
    .exec();

  return { userId, usage: { total_tokens: totalTokens, total_cost: totalCost }, now };
}

export async function releaseUsageEstimate(reservation: { userId: string; usage: { total_tokens: number; total_cost: number }; now?: Date } | null | undefined) {
  if (!reservation) return;
  const daily = reservationKeys(reservation.userId, "daily", reservation.now);
  const monthly = reservationKeys(reservation.userId, "monthly", reservation.now);
  const totalTokens = Math.max(0, Math.trunc(parseNumber(reservation.usage.total_tokens, 0)));
  const totalCost = Math.max(0, parseNumber(reservation.usage.total_cost, 0));

  await redis.eval(
    `
      local tokenDelta = tonumber(ARGV[1])
      local costDelta = tonumber(ARGV[2])
      for i = 1, 2 do
        local current = tonumber(redis.call("GET", KEYS[i]) or "0")
        local next = current - tokenDelta
        if next <= 0 then redis.call("DEL", KEYS[i]) else redis.call("SET", KEYS[i], tostring(next)) end
      end
      for i = 3, 4 do
        local current = tonumber(redis.call("GET", KEYS[i]) or "0")
        local next = current - costDelta
        if next <= 0 then redis.call("DEL", KEYS[i]) else redis.call("SET", KEYS[i], tostring(next)) end
      end
      return 1
    `,
    4,
    daily.tokens,
    monthly.tokens,
    daily.cost,
    monthly.cost,
    String(totalTokens),
    String(totalCost),
  );
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
    redis.expire(dailyKeys.tokens, USAGE_KEY_TTL_SECONDS),
    redis.expire(monthlyKeys.tokens, USAGE_KEY_TTL_SECONDS),
    redis.expire(dailyKeys.cost, USAGE_KEY_TTL_SECONDS),
    redis.expire(monthlyKeys.cost, USAGE_KEY_TTL_SECONDS),
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
  requestedModel?: string | null;
  resolvedModel?: string | null;
  routingReason?: string | null;
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
    requested_model: args.requestedModel || null,
    resolved_model: args.resolvedModel || null,
    routing_reason: args.routingReason || null,
    started_at: args.startedAt.toISOString(),
    completed_at: args.completedAt.toISOString(),
  };
  redis.lpush("request_perf_queue", JSON.stringify(payload)).catch((e) => {
    writeSystemLog("error", "Failed to enqueue request performance", { error: e?.message || String(e) });
  });
}

// ─── Streaming with usage tracking ───────────────────────────────────────────

export async function* streamWithUsageTracking(
  response: Response,
  userId: string | null,
  hooks?: {
    onUsage?: (data: any) => Promise<void> | void;
    onMissingUsage?: () => Promise<void> | void;
  }
): AsyncGenerator<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  let sawUsage = false;
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
                if (data.usage) {
                  sawUsage = true;
                  await processUsage(userId, data.model || "", data.usage);
                  await hooks?.onUsage?.(data);
                }
              } catch (e) {
                console.debug("[stream] Failed to parse SSE chunk:", e);
              }
            }
          }
        }
      } catch { }
    }
  } finally {
    if (!sawUsage) {
      await hooks?.onMissingUsage?.();
    }
    reader.releaseLock();
  }
}
