import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";

const dbPath = process.env.DATABASE_PATH || "data/database.sqlite";

// Ensure directory exists
const dir = dirname(dbPath);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

export const db = new Database(dbPath);

// Initialize schema
db.run(`
  CREATE TABLE IF NOT EXISTS policies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    daily_token_limit INTEGER DEFAULT -1,
    monthly_token_limit INTEGER DEFAULT -1,
    allowed_models TEXT DEFAULT '*', -- '*' for all, or comma-separated
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, -- Email or ID from OpenWebUI
    is_active INTEGER DEFAULT 1,
    policy_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (policy_id) REFERENCES policies(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    model TEXT,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    ts DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Insert default policy if not exists
const defaultPolicy = db.query("SELECT * FROM policies WHERE id = 'default'").get();
if (!defaultPolicy) {
  db.run(`
    INSERT INTO policies (id, name, daily_token_limit, monthly_token_limit, allowed_models)
    VALUES ('default', 'Default Student Policy', 50000, 1000000, '*')
  `);
}

console.log("📂 SQLite Database initialized at:", dbPath);
