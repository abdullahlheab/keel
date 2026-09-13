// SQLite access via Node's built-in driver. Schema migrations run at startup.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const DB_PATH = process.env.NODE_ENV === 'test' && !process.env.DATA_DIR
  ? ':memory:'
  : path.join(config.dataDir, 'tracker.sqlite');

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA synchronous = NORMAL');

export const now = () => new Date().toISOString();

const MIGRATIONS = [
  // 1: initial schema
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    totp_secret_enc TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    recovery_codes TEXT,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    avatar_color TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE memberships (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
    created_at TEXT NOT NULL,
    UNIQUE(company_id, user_id)
  );
  CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    email TEXT,
    role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    accepted_by TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    mfa_pending INTEGER NOT NULL DEFAULT 0,
    ip TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name_enc TEXT NOT NULL,
    description_enc TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('planning','active','on_hold','completed','archived')),
    color TEXT,
    budget_cents_enc TEXT,
    start_date TEXT,
    end_date TEXT,
    lead_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_projects_company ON projects(company_id);
  CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    UNIQUE(company_id, name)
  );
  CREATE TABLE expenses (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    amount_cents_enc TEXT NOT NULL,
    currency TEXT NOT NULL,
    date TEXT NOT NULL,
    vendor_enc TEXT,
    description_enc TEXT,
    notes_enc TEXT,
    payment_method TEXT,
    paid_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('pending','paid','reimbursed')),
    recurring TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_expenses_company_date ON expenses(company_id, date);
  CREATE INDEX idx_expenses_project ON expenses(project_id);
  CREATE TABLE receipts (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    filename_enc TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    stored_name TEXT NOT NULL,
    uploaded_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_receipts_expense ON receipts(expense_id);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    number INTEGER NOT NULL,
    title_enc TEXT NOT NULL,
    description_enc TEXT,
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('backlog','todo','in_progress','review','done')),
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
    assignee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    due_date TEXT,
    labels_enc TEXT,
    checklist_enc TEXT,
    position REAL NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(company_id, number)
  );
  CREATE INDEX idx_tasks_company_status ON tasks(company_id, status, position);
  CREATE INDEX idx_tasks_project ON tasks(project_id);
  CREATE TABLE task_comments (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    body_enc TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT
  );
  CREATE INDEX idx_comments_task ON task_comments(task_id);
  CREATE TABLE activity (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    summary_enc TEXT NOT NULL,
    meta_enc TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_activity_company ON activity(company_id, created_at);
  CREATE INDEX idx_activity_entity ON activity(entity_type, entity_id);
  CREATE TABLE company_counters (
    company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    task_seq INTEGER NOT NULL DEFAULT 0
  );
  `,
];

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get();
  let version = row ? row.version : 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version];
    db.exec('BEGIN');
    try {
      db.exec(sql);
      version += 1;
      db.prepare('UPDATE schema_version SET version = ?').run(version);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
migrate();

// Run fn inside a transaction (nested calls just join the outer one).
let depth = 0;
export function tx(fn) {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth += 1;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth -= 1;
  }
}

export function one(sql, ...params) { return db.prepare(sql).get(...params) ?? null; }
export function all(sql, ...params) { return db.prepare(sql).all(...params); }
export function run(sql, ...params) { return db.prepare(sql).run(...params); }
