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

// SQLite has no uuid() builtin. Ids that the API hands back must match the dashed v4 shape
// randomUUID() produces, because `rules.id()` validates that format on the way back in.
export const SQL_UUID = `lower(substr(hex(randomblob(4)),1,8) || '-' || substr(hex(randomblob(2)),1,4) || '-4' || substr(hex(randomblob(2)),2,3) || '-' || substr('89ab',1+(abs(random())%4),1) || substr(hex(randomblob(2)),2,3) || '-' || substr(hex(randomblob(6)),1,12))`;

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
  // 2: API keys (only a SHA-256 hash of each key is stored)
  `
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL CHECK (scope IN ('read','write')),
    expires_at TEXT,
    revoked_at TEXT,
    last_used_at TEXT,
    last_used_ip TEXT,
    request_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_api_keys_company ON api_keys(company_id);
  `,
  // 3: two-factor hardening - per-session attempt counter and TOTP replay protection
  `
  ALTER TABLE sessions ADD COLUMN mfa_attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN totp_last_counter INTEGER;
  `,
  // 4: discussion room - forum topics with threaded replies
  `
  CREATE TABLE discussion_topics (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    number INTEGER NOT NULL,
    title_enc TEXT NOT NULL,
    body_enc TEXT,
    category TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('general','announcement','question','idea','decision')),
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved','archived')),
    pinned INTEGER NOT NULL DEFAULT 0,
    locked INTEGER NOT NULL DEFAULT 0,
    answer_post_id TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- set only when the title or body changes, so pinning or resolving never shows up as "edited"
    edited_at TEXT,
    last_post_at TEXT NOT NULL,
    UNIQUE(company_id, number)
  );
  CREATE INDEX idx_topics_company ON discussion_topics(company_id, pinned DESC, last_post_at DESC);
  CREATE INDEX idx_topics_project ON discussion_topics(project_id);
  CREATE TABLE discussion_posts (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    topic_id TEXT NOT NULL REFERENCES discussion_topics(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES discussion_posts(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    body_enc TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT
  );
  CREATE INDEX idx_posts_topic ON discussion_posts(topic_id, created_at);
  ALTER TABLE company_counters ADD COLUMN topic_seq INTEGER NOT NULL DEFAULT 0;
  `,
  // 5: task status history, so flow and burnup charts can be drawn over time.
  // project_id is a snapshot rather than a foreign key: deleting a project must not erase the
  // history of the work that was in it.
  `
  CREATE TABLE task_events (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    project_id TEXT,
    from_status TEXT,
    to_status TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX idx_task_events_company ON task_events(company_id, at);
  CREATE INDEX idx_task_events_task ON task_events(task_id, at);
  `,
  // 6: project categories. A table of their own rather than a flag on `categories`, so a name like
  // "Marketing" can be both an expense category and a project category.
  `
  CREATE TABLE project_categories (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    UNIQUE(company_id, name)
  );
  ALTER TABLE projects ADD COLUMN category_id TEXT REFERENCES project_categories(id) ON DELETE SET NULL;

  -- Give every company that already exists the same starting set a new one gets.
  INSERT INTO project_categories (id, company_id, name, color, sort_order)
  SELECT ${SQL_UUID}, c.id, v.name, v.color, v.pos
  FROM companies c
  JOIN (SELECT 'Client work' AS name, '#2a78d6' AS color, 0 AS pos
        UNION ALL SELECT 'Internal', '#4a3aa7', 1
        UNION ALL SELECT 'Product', '#1baf7a', 2
        UNION ALL SELECT 'Research', '#eda100', 3
        UNION ALL SELECT 'Operations', '#898781', 4) v;

  -- Seed history for work that already exists. Creation and completion are the two moments we can
  -- recover exactly; anything in between was never recorded, so charts before this point show a
  -- task as open from the day it was created until the day it was finished.
  INSERT INTO task_events (id, company_id, task_id, project_id, from_status, to_status, at)
  SELECT lower(hex(randomblob(16))), company_id, id, project_id, NULL,
         CASE WHEN completed_at IS NOT NULL THEN 'todo' ELSE status END, created_at
  FROM tasks;

  INSERT INTO task_events (id, company_id, task_id, project_id, from_status, to_status, at)
  SELECT lower(hex(randomblob(16))), company_id, id, project_id, 'todo', 'done', completed_at
  FROM tasks WHERE completed_at IS NOT NULL;
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
