// Row -> API object mappers (decrypting on the way out) and shared queries.
import { all, one } from '../db.js';
import { decrypt, decryptInt, decryptJSON } from '../crypto.js';

export function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, avatarColor: u.avatar_color || null };
}

export function companyRow(c) {
  return { id: c.id, name: c.name, key: c.key, currency: c.currency, createdAt: c.created_at };
}

export function categoryRow(c) {
  return { id: c.id, name: c.name, color: c.color, sortOrder: c.sort_order, archived: Boolean(c.archived) };
}

export function projectRow(r) {
  return {
    id: r.id,
    name: decrypt(r.name_enc),
    description: decrypt(r.description_enc),
    status: r.status,
    color: r.color,
    budgetCents: decryptInt(r.budget_cents_enc),
    startDate: r.start_date,
    endDate: r.end_date,
    leadUserId: r.lead_user_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function expenseRow(r) {
  return {
    id: r.id,
    projectId: r.project_id,
    categoryId: r.category_id,
    amountCents: decryptInt(r.amount_cents_enc),
    currency: r.currency,
    date: r.date,
    vendor: decrypt(r.vendor_enc),
    description: decrypt(r.description_enc),
    notes: decrypt(r.notes_enc),
    paymentMethod: r.payment_method,
    paidByUserId: r.paid_by_user_id,
    status: r.status,
    recurring: r.recurring,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function receiptRow(r) {
  return { id: r.id, expenseId: r.expense_id, filename: decrypt(r.filename_enc), mime: r.mime, size: r.size, createdAt: r.created_at };
}

export function taskRow(r) {
  return {
    id: r.id,
    number: r.number,
    ref: r.company_key ? `${r.company_key}-${r.number}` : undefined,
    projectId: r.project_id,
    title: decrypt(r.title_enc),
    description: decrypt(r.description_enc),
    status: r.status,
    priority: r.priority,
    assigneeUserId: r.assignee_user_id,
    dueDate: r.due_date,
    labels: decryptJSON(r.labels_enc, []),
    checklist: decryptJSON(r.checklist_enc, []),
    position: r.position,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    commentCount: r.comment_count ?? undefined,
  };
}

export function commentRow(r) {
  return { id: r.id, taskId: r.task_id, userId: r.user_id, body: decrypt(r.body_enc), createdAt: r.created_at, updatedAt: r.updated_at };
}

export function topicRow(r) {
  return {
    id: r.id,
    number: r.number,
    ref: r.company_key ? `${r.company_key}-D${r.number}` : undefined,
    projectId: r.project_id,
    title: decrypt(r.title_enc),
    body: decrypt(r.body_enc),
    category: r.category,
    state: r.state,
    pinned: Boolean(r.pinned),
    locked: Boolean(r.locked),
    answerPostId: r.answer_post_id,
    replyCount: r.reply_count ?? undefined,
    lastPostBy: r.last_post_by ?? undefined,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    editedAt: r.edited_at,
    lastPostAt: r.last_post_at,
  };
}

export function postRow(r, answerPostId = null) {
  return {
    id: r.id,
    topicId: r.topic_id,
    parentId: r.parent_id,
    userId: r.user_id,
    body: decrypt(r.body_enc),
    isAnswer: Boolean(answerPostId) && r.id === answerPostId,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------- shared queries ----------
export function getMembers(companyId) {
  return all(`SELECT u.id, u.name, u.email, u.avatar_color, m.role, m.created_at AS joined_at
              FROM memberships m JOIN users u ON u.id = m.user_id
              WHERE m.company_id = ? ORDER BY m.created_at ASC`, companyId)
    .map((r) => ({ ...publicUser(r), role: r.role, joinedAt: r.joined_at }));
}

export function getProject(companyId, id) {
  const r = one('SELECT * FROM projects WHERE company_id = ? AND id = ?', companyId, id);
  return r ? projectRow(r) : null;
}

export function listProjects(companyId) {
  return all('SELECT * FROM projects WHERE company_id = ? ORDER BY created_at DESC', companyId).map(projectRow);
}

export function listExpensesRaw(companyId) {
  return all('SELECT * FROM expenses WHERE company_id = ? ORDER BY date DESC, created_at DESC', companyId).map(expenseRow);
}

// Per-project spend and task progress for a company.
export function projectStats(companyId) {
  const stats = new Map();
  const ensure = (pid) => {
    if (!stats.has(pid)) stats.set(pid, { spentCents: 0, expenseCount: 0, taskTotal: 0, taskDone: 0, taskOpen: 0 });
    return stats.get(pid);
  };
  for (const e of listExpensesRaw(companyId)) {
    if (!e.projectId) continue;
    const s = ensure(e.projectId);
    s.spentCents += e.amountCents || 0;
    s.expenseCount += 1;
  }
  for (const t of all('SELECT project_id, status, count(*) AS c FROM tasks WHERE company_id = ? AND project_id IS NOT NULL GROUP BY project_id, status', companyId)) {
    const s = ensure(t.project_id);
    s.taskTotal += t.c;
    if (t.status === 'done') s.taskDone += t.c; else s.taskOpen += t.c;
  }
  return stats;
}

export function nextTaskNumber(db, companyId) {
  return nextNumber(db, companyId, 'task_seq');
}

export function nextTopicNumber(db, companyId) {
  return nextNumber(db, companyId, 'topic_seq');
}

// Bumps one of the per-company counters and returns the new value. Call inside a transaction.
function nextNumber(db, companyId, column) {
  db.prepare('INSERT INTO company_counters (company_id) VALUES (?) ON CONFLICT(company_id) DO NOTHING').run(companyId);
  db.prepare(`UPDATE company_counters SET ${column} = ${column} + 1 WHERE company_id = ?`).run(companyId);
  return db.prepare(`SELECT ${column} AS n FROM company_counters WHERE company_id = ?`).get(companyId).n;
}

export function monthKey(date) { return String(date).slice(0, 7); }

export function centsToDecimal(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
