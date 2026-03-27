import { Elysia } from "elysia";
import { db, webuiDb, pool, webuiPool } from "../db";
import { redis } from "../redis";
import {
  runtimeConfig,
  systemLogs,
  writeSystemLog,
  CONFIG_KEYS,
  CONFIG_SYNC_CHANNEL,
  maskConfigValue,
  validateConfigMap,
  persistConfig,
  loadRuntimeConfigFromDb,
} from "../services/config";
import {
  getUserGroups,
  getUserCached,
  getPolicyCached,
  resolveEffectivePolicy,
  getUsageSnapshotAll,
  evaluatePolicyLimit,
  describeLimit,
  summarizePolicy,
  normalizePolicyInput,
  invalidateUserCache,
  invalidatePolicyCache,
  parseNumber,
  REQUEST_LOG_SAMPLE_RATE,
} from "../services/quota";
import { reportRoutes } from "./reports";

// ─── Health check ─────────────────────────────────────────────────────────────

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
    await webuiDb.get("SELECT 1 as ok");
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

// ─── Admin routes ─────────────────────────────────────────────────────────────

export const adminRoutes = new Elysia({ prefix: "/admin" })
  .onBeforeHandle(({ request, set }) => {
    const auth = request.headers.get("x-admin-key");
    if (auth !== runtimeConfig.ADMIN_API_KEY) {
      set.status = 401;
      return "Unauthorized";
    }
  })

  // ── Users ──────────────────────────────────────────────────────────────────
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

  .patch("/users/:id", async ({ params, body }: any) => {
    const { is_active, policy_id } = body;
    if (is_active !== undefined) {
      await db.run("UPDATE users SET is_active = $1 WHERE id = $2", [is_active ? 1 : 0, params.id]);
    }
    if (policy_id !== undefined) {
      await db.run("UPDATE users SET policy_id = $1 WHERE id = $2", [policy_id, params.id]);
    }
    invalidateUserCache(params.id);
    return { success: true };
  })

  // ── Policies ───────────────────────────────────────────────────────────────
  .get("/policies", () => db.all("SELECT * FROM policies ORDER BY created_at DESC"))

  .post("/policies", async ({ body, set }: any) => {
    let policy;
    try {
      policy = normalizePolicyInput(body);
    } catch (e: any) {
      set.status = 400;
      return { success: false, error: e?.message || String(e) };
    }

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
        policy.id, policy.name,
        policy.daily_token_limit, policy.monthly_token_limit, policy.allowed_models,
        policy.limit_type, policy.scope_period, policy.token_limit, policy.cost_limit,
        policy.formula_kind, JSON.stringify(policy.formula_config || {}),
        policy.daily_cost_limit, policy.monthly_cost_limit,
      ]
    );
    invalidatePolicyCache(policy.id);
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
    if (params.id === "default") return { success: false, error: "Cannot delete default policy" };
    await db.run("DELETE FROM policies WHERE id = $1", [params.id]);
    invalidatePolicyCache(params.id);
    return { success: true };
  })

  // ── Group policies ─────────────────────────────────────────────────────────
  .get("/group-policies", () => db.all("SELECT * FROM group_policies ORDER BY priority DESC, group_name ASC"))

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

  // ── Usage & stats ──────────────────────────────────────────────────────────
  .get("/usage", () => db.all("SELECT * FROM usage_logs ORDER BY ts DESC LIMIT 100"))

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
        max_latency_ms: Number(perf?.max_latency_ms || 0),
      },
      top_models: topModels,
      top_users: topUsers,
    };
  })

  // ── Performance logs ───────────────────────────────────────────────────────
  .get("/performance", async ({ query }: any) => {
    const q = query || {};
    const where: string[] = ["started_at >= NOW() - INTERVAL '24 hours'"];
    const params: any[] = [];

    if (q.user_id) { params.push(`%${q.user_id}%`); where.push(`user_id ILIKE $${params.length}`); }
    if (q.model) { params.push(`%${q.model}%`); where.push(`model ILIKE $${params.length}`); }
    if (q.path) { params.push(`%${q.path}%`); where.push(`path ILIKE $${params.length}`); }
    if (q.status) { params.push(Number(q.status)); where.push(`status = $${params.length}`); }

    const whereSql = `WHERE ${where.join(" AND ")}`;

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
      FROM request_logs ${whereSql}
    `, params);

    const recent = await db.all(`
      SELECT id, user_id, model, path, method, status, is_stream, latency_ms, total_cost, started_at, completed_at
      FROM request_logs ${whereSql}
      ORDER BY id DESC LIMIT 200
    `, params);

    return { summary, recent, sample_rate: REQUEST_LOG_SAMPLE_RATE };
  })

  // ── Config ─────────────────────────────────────────────────────────────────
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

  // ── System ─────────────────────────────────────────────────────────────────
  .get("/health", async () => await getSystemHealth())
  .get("/system-logs", () => ({ logs: systemLogs }))

  // ── Reports sub-group ──────────────────────────────────────────────────────
  .use(reportRoutes);
