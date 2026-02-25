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

async function checkAccess(userId: string): Promise<{ allowed: boolean; reason?: string; groups: string[] }> {
  const user: any = await getUserCached(userId);
  const groups = await getUserGroups(userId);

  if (!user || !user.is_active) return { allowed: false, reason: "User inactive or not found", groups };

  const activePolicyId = await resolveEffectivePolicy(user, groups);
  const policy: any = await getPolicyCached(activePolicyId);
  
  if (!policy) return { allowed: false, reason: `Policy ${activePolicyId} not found`, groups };

  const dailyKey = `usage:user:${userId}:daily:${new Date().toISOString().split('T')[0]}`;
  const monthlyKey = `usage:user:${userId}:monthly:${new Date().toISOString().slice(0, 7)}`;

  const usageVals = await redis.mget(dailyKey, monthlyKey);
  const dailyUsage = parseInt(usageVals?.[0] || "0");
  const monthlyUsage = parseInt(usageVals?.[1] || "0");

  if (policy.daily_token_limit > 0 && dailyUsage >= parseInt(policy.daily_token_limit)) {
    return { allowed: false, reason: "Daily token limit exceeded", groups };
  }

  if (policy.monthly_token_limit > 0 && monthlyUsage >= parseInt(policy.monthly_token_limit)) {
    return { allowed: false, reason: "Monthly token limit exceeded", groups };
  }

  return { allowed: true, groups };
}

async function processUsage(userId: string | null, model: string, usage: any) {
  if (!userId) return;
  const dailyKey = `usage:user:${userId}:daily:${new Date().toISOString().split('T')[0]}`;
  const monthlyKey = `usage:user:${userId}:monthly:${new Date().toISOString().slice(0, 7)}`;
  const total = usage.total_tokens || (usage.prompt_tokens + usage.completion_tokens);
  const cost = usage.cost || usage.total_cost || 0;
  
  await Promise.all([
    redis.incrby(dailyKey, total),
    redis.incrby(monthlyKey, total),
    redis.expire(dailyKey, 3456000),
    redis.expire(monthlyKey, 3456000),
    redis.lpush("usage_queue", JSON.stringify({
      user_id: userId, model, prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens, total_tokens: total, 
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
          `INSERT INTO request_logs (user_id, model, path, method, status, is_stream, latency_ms, started_at, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [p.user_id, p.model, p.path, p.method, p.status, p.is_stream, p.latency_ms, p.started_at, p.completed_at]
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
}) {
  const latencyMs = Math.max(0, args.completedAt.getTime() - args.startedAt.getTime());
  const payload = {
    user_id: args.userId,
    model: args.model,
    path: args.path,
    method: args.method,
    status: args.status,
    is_stream: args.isStream,
    latency_ms: latencyMs,
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
        if (!access.allowed) { set.status = 403; return { error: access.reason }; }
        body.user = userId;
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

    if (!upstreamResponse.ok) {
      writeSystemLog("warn", "Upstream returned non-2xx", {
        status: upstreamResponse.status,
        path,
        userId,
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
            });
          }
        },
      });
      return new Response(stream, { status: upstreamResponse.status, headers: responseHeaders });
    } else {
      const respData = await upstreamResponse.json();
      if (respData.usage) await processUsage(userId, respData.model || modelName, respData.usage);
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
      });
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
            results.push({ ...user, groups, effective_policy_id: effectivePolicyId });
        }
        return results;
      })
      .get("/policies", () => db.all("SELECT * FROM policies ORDER BY created_at DESC"))
      .get("/usage", () => db.all("SELECT * FROM usage_logs ORDER BY ts DESC LIMIT 100"))
      .get("/group-policies", () => db.all("SELECT * FROM group_policies ORDER BY priority DESC"))
      .get("/openwebui-groups", () => webuiDb.all('SELECT name FROM "group"'))
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
      .post("/policies", async ({ body }: any) => {
        const { id, name, daily_token_limit, monthly_token_limit, allowed_models } = body;
        await db.run(
          "INSERT INTO policies (id, name, daily_token_limit, monthly_token_limit, allowed_models) VALUES ($1, $2, $3, $4, $5) ON CONFLICT(id) DO UPDATE SET name=excluded.name, daily_token_limit=excluded.daily_token_limit, monthly_token_limit=excluded.monthly_token_limit, allowed_models=excluded.allowed_models",
          [id, name, daily_token_limit, monthly_token_limit, allowed_models]
        );
        policyCache.delete(id);
        return { success: true };
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
      .get("/performance", async () => {
        const summary = await db.get(`
          SELECT
            COUNT(*)::int AS requests,
            COALESCE(AVG(latency_ms), 0)::float AS avg_latency_ms,
            COALESCE(MAX(latency_ms), 0)::int AS max_latency_ms,
            COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY latency_ms), 0)::float AS p50_latency_ms,
            COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::float AS p95_latency_ms,
            COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms), 0)::float AS p99_latency_ms
          FROM request_logs
          WHERE started_at >= NOW() - INTERVAL '24 hours'
        `);

        const recent = await db.all(`
          SELECT id, user_id, model, path, method, status, is_stream, latency_ms, started_at, completed_at
          FROM request_logs
          ORDER BY id DESC
          LIMIT 200
        `);

        return { summary, recent };
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
  .listen(8080);

console.log(`🦊 AI Control Plane running at http://localhost:${app.server?.port}`);
writeSystemLog("info", "Middleware started", { port: app.server?.port });
await initDb();
await ensureConfigStore();
await loadRuntimeConfigFromDb();
await startConfigSubscriber();
startBackgroundWorker();
