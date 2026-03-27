import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { pool, webuiPool, initDb } from "./db";
import { redis } from "./redis";
import { writeSystemLog, ensureConfigStore, loadRuntimeConfigFromDb, startConfigSubscriber } from "./services/config";
import { proxyRoutes } from "./routes/proxy";
import { adminRoutes } from "./routes/admin";

// ─── Startup validation ───────────────────────────────────────────────────────

const required = ["OPENROUTER_API_KEY", "ADMIN_API_KEY", "OPENROUTER_HTTP_REFERER", "OPENROUTER_X_TITLE", "LOG_MODE"] as const;
const missing = required.filter((k) => !process.env[k] || process.env[k]!.trim() === "");
if (missing.length) throw new Error(`Missing required config: ${missing.join(", ")}`);

// ─── Background worker ────────────────────────────────────────────────────────

let workerStopping = false;

async function drainQueue(queue: string, batchSize = 50): Promise<any[]> {
  const items: any[] = [];
  for (let i = 0; i < batchSize; i++) {
    const item = await redis.rpop(queue);
    if (!item) break;
    try { items.push(JSON.parse(item)); } catch { }
  }
  return items;
}

async function flushQueues() {
  try {
    const usageBatch = await drainQueue("usage_queue", 500);
    for (const data of usageBatch) {
      await pool.query(
        "INSERT INTO usage_logs (user_id, model, prompt_tokens, completion_tokens, total_tokens, total_cost, ts) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [data.user_id, data.model, data.prompt_tokens, data.completion_tokens, data.total_tokens, data.total_cost, data.ts]
      );
    }
    const perfBatch = await drainQueue("request_perf_queue", 500);
    for (const p of perfBatch) {
      await pool.query(
        `INSERT INTO request_logs (user_id, model, path, method, status, is_stream, latency_ms, total_cost, denied_reason, denied_category, started_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [p.user_id, p.model, p.path, p.method, p.status, p.is_stream, p.latency_ms, p.total_cost || 0, p.denied_reason || null, p.denied_category || null, p.started_at, p.completed_at]
      );
    }
    if (usageBatch.length || perfBatch.length) {
      console.log(`[worker] Flushed ${usageBatch.length} usage + ${perfBatch.length} perf records on shutdown`);
    }
  } catch (e: any) {
    console.error("[worker] Error during final flush:", e?.message || e);
  }
}

async function startBackgroundWorker() {
  console.log("👷 Background Worker started");
  while (!workerStopping) {
    try {
      const usageBatch = await drainQueue("usage_queue", 100);
      for (const data of usageBatch) {
        await pool.query(
          "INSERT INTO usage_logs (user_id, model, prompt_tokens, completion_tokens, total_tokens, total_cost, ts) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [data.user_id, data.model, data.prompt_tokens, data.completion_tokens, data.total_tokens, data.total_cost, data.ts]
        );
      }

      const perfBatch = await drainQueue("request_perf_queue", 100);
      for (const p of perfBatch) {
        await pool.query(
          `INSERT INTO request_logs (user_id, model, path, method, status, is_stream, latency_ms, total_cost, denied_reason, denied_category, started_at, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [p.user_id, p.model, p.path, p.method, p.status, p.is_stream, p.latency_ms, p.total_cost || 0, p.denied_reason || null, p.denied_category || null, p.started_at, p.completed_at]
        );
      }

      if (usageBatch.length === 0 && perfBatch.length === 0) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, 1000);
          // Allow the timeout to be cancelled quickly during shutdown
          if (workerStopping) { clearTimeout(t); r(); }
        });
      }
    } catch (e: any) {
      console.error("Worker Error:", e);
      writeSystemLog("error", "Background worker error", { error: e?.message || String(e) });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  console.log("👷 Background Worker stopped");
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] ${signal} received — draining queues and closing connections...`);
  writeSystemLog("info", "Shutdown initiated", { signal });

  // Signal the worker loop to stop
  workerStopping = true;

  // Give the worker up to 5 s to finish its current batch
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  // Final flush of anything still in Redis queues
  await flushQueues();

  // Close connections
  try { await pool.end(); } catch { }
  try { await webuiPool.end(); } catch { }
  try { redis.disconnect(); } catch { }

  console.log("[shutdown] Clean exit");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── App ──────────────────────────────────────────────────────────────────────

const app = new Elysia()
  .use(cors())
  .use(proxyRoutes)
  .use(adminRoutes)
  .get("/health", () => ({ status: "ok", engine: "elysia", storage: "hybrid" }))
  .get("/", () => Bun.file("public/index.html"))
  .get("/js/admin.js", () => Bun.file("public/js/admin.js"))
  .get("/js/reports.js", () => Bun.file("public/js/reports.js"))
  .get("/js/policies.js", () => Bun.file("public/js/policies.js"))
  .listen(8080);

// ─── Startup sequence ─────────────────────────────────────────────────────────

console.log(`🦊 AI Control Plane running at http://localhost:${app.server?.port}`);
writeSystemLog("info", "Middleware started", { port: app.server?.port });
await initDb();
await ensureConfigStore();
await loadRuntimeConfigFromDb();
await startConfigSubscriber();
startBackgroundWorker();
