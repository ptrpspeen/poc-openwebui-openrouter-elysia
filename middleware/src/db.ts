import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL || "postgresql://admin:adminpassword@localhost:5432/ai_control";

export const pool = new Pool({
  connectionString,
});

// Helper for easier queries
export const db = {
  query: async (text: string, params?: any[]) => {
    const res = await pool.query(text, params);
    return res;
  },
  get: async (text: string, params?: any[]) => {
    const res = await pool.query(text, params);
    return res.rows[0];
  },
  run: async (text: string, params?: any[]) => {
    return await pool.query(text, params);
  },
  all: async (text: string, params?: any[]) => {
    const res = await pool.query(text, params);
    return res.rows;
  }
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

  // Migration: Add total_cost column if it doesn't exist
  try {
    await db.run("ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS total_cost NUMERIC(15, 10) DEFAULT 0");
  } catch (e) {
    console.log("Column total_cost might already exist or migration skipped.");
  }

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
