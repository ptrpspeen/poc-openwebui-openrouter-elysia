import { Pool } from "pg";

const required = ["DATABASE_URL", "WEBUI_DATABASE_URL"] as const;
const missing = required.filter((k) => !process.env[k] || process.env[k]!.trim() === "");
if (missing.length) {
  throw new Error(`Missing required config: ${missing.join(", ")}`);
}

const connectionString = process.env.DATABASE_URL as string;
const webuiConnectionString = process.env.WEBUI_DATABASE_URL as string;

export const pool = new Pool({ connectionString });
export const webuiPool = new Pool({ connectionString: webuiConnectionString });

// Helper for easier queries
export const db = {
  query: async (text: string, params?: any[]) => await pool.query(text, params),
  get: async (text: string, params?: any[]) => (await pool.query(text, params)).rows[0],
  run: async (text: string, params?: any[]) => await pool.query(text, params),
  all: async (text: string, params?: any[]) => (await pool.query(text, params)).rows
};

export const webuiDb = {
    get: async (text: string, params?: any[]) => (await webuiPool.query(text, params)).rows[0],
    all: async (text: string, params?: any[]) => (await webuiPool.query(text, params)).rows,
    run: async (text: string, params?: any[]) => await webuiPool.query(text, params)
};

export async function initDb() {
  console.log("🐘 Initializing PostgreSQL Database...");
  
  let retries = 5;
  while (retries > 0) {
    try {
      await db.run("SELECT 1");
      break;
    } catch (err) {
      console.log(`⏳ Waiting for PostgreSQL to be ready... (${retries} retries left)`);
      retries -= 1;
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  await db.run(`
    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      daily_token_limit BIGINT DEFAULT -1,
      monthly_token_limit BIGINT DEFAULT -1,
      allowed_models TEXT DEFAULT '*',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      is_active INTEGER DEFAULT 1,
      policy_id TEXT REFERENCES policies(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS group_policies (
      group_name TEXT PRIMARY KEY,
      policy_id TEXT REFERENCES policies(id),
      priority INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      model TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      total_cost NUMERIC(15, 10) DEFAULT 0,
      ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      model TEXT,
      path TEXT,
      method TEXT,
      status INTEGER,
      is_stream BOOLEAN DEFAULT FALSE,
      latency_ms INTEGER,
      total_cost NUMERIC(15, 10) DEFAULT 0,
      started_at TIMESTAMP,
      completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.run(`ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS total_cost NUMERIC(15, 10) DEFAULT 0`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_request_logs_started_at ON request_logs(started_at DESC)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_request_logs_completed_at ON request_logs(completed_at DESC)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_request_logs_user_started ON request_logs(user_id, started_at DESC)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_request_logs_model_started ON request_logs(model, started_at DESC)`);

  // Insert default policy
  const defaultPolicy = await db.get("SELECT * FROM policies WHERE id = $1", ['default']);
  if (!defaultPolicy) {
    await db.run(`
      INSERT INTO policies (id, name, daily_token_limit, monthly_token_limit, allowed_models)
      VALUES ('default', 'Default Student Policy', 50000, 1000000, '*')
    `);
  }
  
  console.log("✅ PostgreSQL Schema verified");
}
