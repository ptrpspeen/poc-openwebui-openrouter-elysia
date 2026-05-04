import { Elysia } from "elysia";
import { db } from "../db";
import { getUserGroups, getUserCached, resolveEffectivePolicy } from "../services/quota";

// ─── Query helpers ────────────────────────────────────────────────────────────

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

const RANGE_HOURS: Record<string, number> = {
  "24 hours": 24,
  "7 days": 24 * 7,
  "30 days": 24 * 30,
  "90 days": 24 * 90,
};

function buildSinceDate(query: any, fallback = "30 days") {
  const since = getReportSince(query, fallback);
  return new Date(Date.now() - RANGE_HOURS[since] * 60 * 60 * 1000).toISOString();
}

function buildPreviousSinceDate(query: any, fallback = "30 days") {
  const since = getReportSince(query, fallback);
  const hours = RANGE_HOURS[since];
  return {
    currentSince: new Date(Date.now() - hours * 60 * 60 * 1000).toISOString(),
    previousSince: new Date(Date.now() - hours * 2 * 60 * 60 * 1000).toISOString(),
  };
}

function pctChange(current: number, previous: number) {
  if (!previous) return current ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

// ─── Reports routes (prefix /reports, mounted under /admin by adminRoutes) ───

export const reportRoutes = new Elysia({ prefix: "/reports" })

  .get("/summary", async ({ query }: any) => {
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
      FROM usage_logs WHERE ts >= $1
    `, [since]);

    const blocked = await db.get(`
      SELECT COUNT(*)::int AS blocked_requests
      FROM request_logs WHERE started_at >= $1 AND status = 403
    `, [since]);

    const topModels = await db.all(`
      SELECT model, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost
      FROM usage_logs WHERE ts >= $1
      GROUP BY model ORDER BY cost DESC, requests DESC LIMIT 10
    `, [since]);

    const topUsers = await db.all(`
      SELECT user_id, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost
      FROM usage_logs WHERE ts >= $1
      GROUP BY user_id ORDER BY cost DESC, tokens DESC LIMIT 10
    `, [since]);

    const previousUsage = await db.get(`
      SELECT COUNT(*)::int AS total_requests, COALESCE(SUM(total_tokens),0)::bigint AS total_tokens, COALESCE(SUM(total_cost),0)::float AS total_cost
      FROM usage_logs WHERE ts >= $1 AND ts < $2
    `, [previousSince, currentSince]);

    const previousBlocked = await db.get(`
      SELECT COUNT(*)::int AS blocked_requests
      FROM request_logs WHERE started_at >= $1 AND started_at < $2 AND status = 403
    `, [previousSince, currentSince]);

    // Aggregate by group (in-process join — groups are in OpenWebUI DB)
    const usageByUser = await db.all(`
      SELECT user_id, COALESCE(SUM(total_cost),0)::float AS cost
      FROM usage_logs WHERE ts >= $1 GROUP BY user_id
    `, [since]);
    const groupCostMap = new Map<string, number>();
    for (const row of usageByUser) {
      const groups = await getUserGroups(row.user_id);
      for (const g of (groups.length ? groups : ["[ungrouped]"])) {
        groupCostMap.set(g, (groupCostMap.get(g) || 0) + Number(row.cost || 0));
      }
    }
    const [topGroupName, topGroupCost] = [...groupCostMap.entries()].sort((a, b) => b[1] - a[1])[0] || ["-", 0];

    return {
      range: getReportSince(query, "30 days"),
      since,
      summary: { ...summary, blocked_requests: Number(blocked?.blocked_requests || 0) },
      comparison: {
        requests_pct: pctChange(Number(summary?.total_requests || 0), Number(previousUsage?.total_requests || 0)),
        tokens_pct: pctChange(Number(summary?.total_tokens || 0), Number(previousUsage?.total_tokens || 0)),
        cost_pct: pctChange(Number(summary?.total_cost || 0), Number(previousUsage?.total_cost || 0)),
        blocked_pct: pctChange(Number(blocked?.blocked_requests || 0), Number(previousBlocked?.blocked_requests || 0)),
        previous: { ...previousUsage, blocked_requests: Number(previousBlocked?.blocked_requests || 0) },
      },
      executive: {
        top_spender: topUsers[0] || null,
        most_expensive_model: topModels[0] || null,
        most_active_group: { group_name: topGroupName, cost: topGroupCost },
      },
      top_models: topModels,
      top_users: topUsers,
    };
  })

  .get("/users", async ({ query }: any) => {
    const since = buildSinceDate(query, "30 days");
    const limit = getLimit(query, 100);
    const rows = await db.all(`
      SELECT user_id, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens,
             COALESCE(SUM(total_cost),0)::float AS cost, COALESCE(MAX(ts), NOW()) AS last_seen
      FROM usage_logs WHERE ts >= $1
      GROUP BY user_id ORDER BY cost DESC, tokens DESC LIMIT ${limit}
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

  .get("/groups", async ({ query }: any) => {
    const since = buildSinceDate(query, "30 days");
    const usageByUser = await db.all(`
      SELECT user_id, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost
      FROM usage_logs WHERE ts >= $1 GROUP BY user_id
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
    const rows = [...groupMap.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
    return { range: getReportSince(query, "30 days"), since, rows };
  })

  .get("/costs", async ({ query }: any) => {
    const since = buildSinceDate(query, "30 days");
    const byDay = await db.all(`
      SELECT DATE(ts) AS day, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost
      FROM usage_logs WHERE ts >= $1
      GROUP BY DATE(ts) ORDER BY day DESC
    `, [since]);
    const byModel = await db.all(`
      SELECT model, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost
      FROM usage_logs WHERE ts >= $1
      GROUP BY model ORDER BY cost DESC, requests DESC
    `, [since]);
    return { range: getReportSince(query, "30 days"), since, by_day: byDay, by_model: byModel };
  })

  .get("/quota-events", async ({ query }: any) => {
    const since = buildSinceDate(query, "30 days");
    const limit = getLimit(query, 200);
    const rows = await db.all(`
      SELECT id, user_id, model, path, method, status, total_cost, denied_reason, denied_category, started_at, completed_at
      FROM request_logs WHERE started_at >= $1 AND status = 403
      ORDER BY id DESC LIMIT ${limit}
    `, [since]);
    const breakdown = await db.all(`
      SELECT COALESCE(denied_category, 'quota') AS category, COUNT(*)::int AS count
      FROM request_logs WHERE started_at >= $1 AND status = 403
      GROUP BY COALESCE(denied_category, 'quota') ORDER BY count DESC
    `, [since]);
    return { range: getReportSince(query, "30 days"), since, rows, breakdown };
  })

  .get("/user/:id", async ({ params, query }: any) => {
    const since = buildSinceDate(query, "30 days");
    const userId = params.id;
    const summary = await db.get(`SELECT user_id, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost, COALESCE(MAX(ts), NOW()) AS last_seen FROM usage_logs WHERE user_id = $1 AND ts >= $2 GROUP BY user_id`, [userId, since]);
    const byDay = await db.all(`SELECT DATE(ts) AS day, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost FROM usage_logs WHERE user_id = $1 AND ts >= $2 GROUP BY DATE(ts) ORDER BY day DESC`, [userId, since]);
    const byModel = await db.all(`SELECT model, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost, COALESCE(MAX(ts), NOW()) AS last_used FROM usage_logs WHERE user_id = $1 AND ts >= $2 GROUP BY model ORDER BY cost DESC, tokens DESC`, [userId, since]);
    const events = await db.all(`SELECT id, denied_category, denied_reason, started_at, path, status FROM request_logs WHERE user_id = $1 AND started_at >= $2 AND status = 403 ORDER BY id DESC LIMIT 100`, [userId, since]);
    const groups = await getUserGroups(userId);
    return { id: userId, since, summary: summary || { user_id: userId, requests: 0, tokens: 0, cost: 0 }, groups, by_day: byDay, by_model: byModel, quota_events: events };
  })

  .get("/group/:name", async ({ params, query }: any) => {
    const since = buildSinceDate(query, "30 days");
    const groupName = decodeURIComponent(params.name);
    const userRows = await db.all(`SELECT user_id, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost FROM usage_logs WHERE ts >= $1 GROUP BY user_id`, [since]);
    const members = [];
    for (const row of userRows) {
      const groups = await getUserGroups(row.user_id);
      if (groups.includes(groupName)) members.push(row);
    }
    const summary = members.reduce(
      (acc, row) => ({ requests: acc.requests + Number(row.requests || 0), tokens: acc.tokens + Number(row.tokens || 0), cost: acc.cost + Number(row.cost || 0), active_users: acc.active_users + 1 }),
      { requests: 0, tokens: 0, cost: 0, active_users: 0 }
    );
    return { name: groupName, since, summary, members };
  })

  .get("/model/:name", async ({ params, query }: any) => {
    const since = buildSinceDate(query, "30 days");
    const model = decodeURIComponent(params.name);
    const summary = await db.get(`SELECT model, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost FROM usage_logs WHERE model = $1 AND ts >= $2 GROUP BY model`, [model, since]);
    const byUser = await db.all(`SELECT user_id, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost FROM usage_logs WHERE model = $1 AND ts >= $2 GROUP BY user_id ORDER BY cost DESC, tokens DESC`, [model, since]);
    const byDay = await db.all(`SELECT DATE(ts) AS day, COUNT(*)::int AS requests, COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(total_cost),0)::float AS cost FROM usage_logs WHERE model = $1 AND ts >= $2 GROUP BY DATE(ts) ORDER BY day DESC`, [model, since]);
    return { name: model, since, summary: summary || { model, requests: 0, tokens: 0, cost: 0 }, by_user: byUser, by_day: byDay };
  })

  .get("/user-models", async ({ query }: any) => {
    const since = buildSinceDate(query, "30 days");
    const limit = getLimit(query, 200);
    const rows = await db.all(`
      SELECT user_id, model, COUNT(*)::int AS requests,
             COALESCE(SUM(total_tokens),0)::bigint AS tokens,
             COALESCE(SUM(total_cost),0)::float AS cost,
             COALESCE(MAX(ts), NOW()) AS last_used
      FROM usage_logs WHERE ts >= $1
      GROUP BY user_id, model ORDER BY cost DESC, tokens DESC, requests DESC LIMIT ${limit}
    `, [since]);
    return { range: getReportSince(query, "30 days"), since, rows };
  })

  .get("/model-users", async ({ query }: any) => {
    const since = buildSinceDate(query, "30 days");
    const limit = getLimit(query, 200);
    const rows = await db.all(`
      SELECT model, user_id, COUNT(*)::int AS requests,
             COALESCE(SUM(total_tokens),0)::bigint AS tokens,
             COALESCE(SUM(total_cost),0)::float AS cost,
             COALESCE(MAX(ts), NOW()) AS last_used
      FROM usage_logs WHERE ts >= $1
      GROUP BY model, user_id ORDER BY cost DESC, tokens DESC, requests DESC LIMIT ${limit}
    `, [since]);
    return { range: getReportSince(query, "30 days"), since, rows };
  });
