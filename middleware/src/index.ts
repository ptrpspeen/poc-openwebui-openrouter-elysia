import { Elysia } from "elysia";
import { db } from "./db";
import { redis } from "./redis";

const OPENROUTER_BASE = "https://openrouter.ai/api";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "admin-secret-key"; // แนะนำให้ตั้งใน .env
const OPENROUTER_HTTP_REFERER = process.env.OPENROUTER_HTTP_REFERER;
const OPENROUTER_X_TITLE = process.env.OPENROUTER_X_TITLE;
const LOG_MODE = process.env.LOG_MODE || "metadata"; 

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const STRIP_HEADERS = new Set([
  "cookie",
  "authorization",
  "x-forwarded-for",
  "x-real-ip",
  "x-forwarded-proto",
  "x-forwarded-host",
  "accept-encoding",
  "host",
  "content-length",
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
    return data.email || data.id || data.sub || null;
  } catch {
    return null;
  }
}

async function ensureUserExists(userId: string) {
  const user = db.query("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) {
    console.log(`👤 Auto-registering new user: ${userId}`);
    db.run(
      "INSERT INTO users (id, policy_id) VALUES (?, ?)",
      [userId, "default"]
    );
  }
}

async function checkAccess(userId: string, model: string): Promise<{ allowed: boolean; reason?: string }> {
  const user: any = db.query("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user || !user.is_active) return { allowed: false, reason: "User inactive or not found" };

  const policy: any = db.query("SELECT * FROM policies WHERE id = ?").get(user.policy_id);
  if (!policy) return { allowed: false, reason: "No policy assigned" };

  if (policy.allowed_models !== "*" && !policy.allowed_models.split(",").includes(model)) {
    return { allowed: false, reason: `Model ${model} not allowed by policy` };
  }

  const dailyKey = `usage:user:${userId}:daily:${new Date().toISOString().split('T')[0]}`;
  const monthlyKey = `usage:user:${userId}:monthly:${new Date().toISOString().slice(0, 7)}`;

  const [dailyUsage, monthlyUsage] = await Promise.all([
    redis.get(dailyKey).then(v => parseInt(v || "0")),
    redis.get(monthlyKey).then(v => parseInt(v || "0"))
  ]);

  if (policy.daily_token_limit > 0 && dailyUsage >= policy.daily_token_limit) {
    return { allowed: false, reason: "Daily token limit exceeded" };
  }

  if (policy.monthly_token_limit > 0 && monthlyUsage >= policy.monthly_token_limit) {
    return { allowed: false, reason: "Monthly token limit exceeded" };
  }

  return { allowed: true };
}

function logEvent(event: Record<string, unknown>) {
  if (LOG_MODE === "off") return;
  console.log(JSON.stringify(event));
}

async function processUsage(userId: string | null, model: string, usage: any) {
  if (!userId) return;

  const dailyKey = `usage:user:${userId}:daily:${new Date().toISOString().split('T')[0]}`;
  const monthlyKey = `usage:user:${userId}:monthly:${new Date().toISOString().slice(0, 7)}`;

  const total = usage.total_tokens || (usage.prompt_tokens + usage.completion_tokens);
  await Promise.all([
    redis.incrby(dailyKey, total),
    redis.incrby(monthlyKey, total),
    redis.expire(dailyKey, 3456000),
    redis.expire(monthlyKey, 3456000),
    redis.lpush("usage_queue", JSON.stringify({
      user_id: userId,
      model,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: total,
      ts: new Date().toISOString()
    }))
  ]);

  logEvent({ type: "usage_tracked", user_id: userId, model, total });
}

async function startBackgroundWorker() {
  console.log("👷 Background Worker started");
  while (true) {
    try {
      const item = await redis.rpop("usage_queue");
      if (item) {
        const data = JSON.parse(item);
        db.run(
          "INSERT INTO usage_logs (user_id, model, prompt_tokens, completion_tokens, total_tokens, ts) VALUES (?, ?, ?, ?, ?, ?)",
          [data.user_id, data.model, data.prompt_tokens, data.completion_tokens, data.total_tokens, data.ts]
        );
      } else {
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch (e) {
      console.error("Worker Error:", e);
    }
  }
}

function cleanResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (
      !HOP_BY_HOP_HEADERS.has(lowerKey) &&
      lowerKey !== "content-length" &&
      lowerKey !== "content-encoding"
    ) {
      result[key] = value;
    }
  });
  return result;
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
  } finally {
    reader.releaseLock();
  }
}

const app = new Elysia()
  .all("/v1/*", async ({ request, params, set }) => {
    if (!OPENROUTER_API_KEY) {
      set.status = 500;
      return "OPENROUTER_API_KEY not set";
    }

    const path = (params as { "*": string })["*"];
    const upstreamUrl = `${OPENROUTER_BASE}/v1/${path}`;

    let userId = request.headers.get("x-openwebui-user-email") || request.headers.get("x-openwebui-user-id");
    if (!userId) {
      const authHeader = request.headers.get("authorization") || "";
      if (authHeader.startsWith("Bearer ")) {
        userId = getUserFromJWT(authHeader.split(" ")[1]);
      }
    }

    if (userId) await ensureUserExists(userId);

    let body: any = null;
    let modelName = "unknown";
    if (request.method === "POST" && request.headers.get("content-type")?.includes("application/json")) {
      body = await request.json();
      modelName = body.model || "unknown";
      if (userId) {
        const access = await checkAccess(userId, modelName);
        if (!access.allowed) {
          set.status = 403;
          return { error: access.reason };
        }
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
      method: request.method,
      headers,
      body: body ? JSON.stringify(body) : (request.method === "GET" ? null : await request.arrayBuffer()),
    });

    const responseHeaders = cleanResponseHeaders(upstreamResponse.headers);

    if (upstreamResponse.headers.get("content-type")?.includes("text/event-stream")) {
      const stream = new ReadableStream({
        async start(controller) {
          for await (const chunk of streamWithUsageTracking(upstreamResponse, userId)) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
      return new Response(stream, { status: upstreamResponse.status, headers: responseHeaders });
    } else {
      const respData = await upstreamResponse.json();
      if (respData.usage) await processUsage(userId, respData.model || modelName, respData.usage);
      return new Response(JSON.stringify(respData), { status: upstreamResponse.status, headers: responseHeaders });
    }
  })
  .get("/health", () => ({ status: "ok", engine: "elysia", storage: "hybrid" }))
  .group("/admin", (app) =>
    app
      .onBeforeHandle(({ request, set }) => {
        const auth = request.headers.get("x-admin-key");
        if (auth !== ADMIN_API_KEY) {
          set.status = 401;
          return "Unauthorized";
        }
      })
      .get("/users", () => db.query("SELECT * FROM users").all())
      .get("/policies", () => db.query("SELECT * FROM policies").all())
      .get("/usage", () => db.query("SELECT * FROM usage_logs ORDER BY ts DESC LIMIT 100").all())
      .post("/policies", ({ body }: any) => {
        const { id, name, daily_token_limit, monthly_token_limit, allowed_models } = body;
        db.run(
          "INSERT INTO policies (id, name, daily_token_limit, monthly_token_limit, allowed_models) VALUES (?, ?, ?, ?, ?)",
          [id, name, daily_token_limit, monthly_token_limit, allowed_models]
        );
        return { success: true };
      })
  )
  .listen(8080);

console.log(`🦊 AI Control Plane running at http://localhost:${app.server?.port}`);
startBackgroundWorker();
