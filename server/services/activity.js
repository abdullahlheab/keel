// Company-wide audit trail. Summaries and metadata are encrypted at rest.
import { db, now } from '../db.js';
import { uid, encrypt, encryptJSON, decrypt, decryptJSON } from '../crypto.js';

export function logActivity({ companyId, userId = null, action, entityType, entityId = null, summary, meta = null }) {
  db.prepare(`INSERT INTO activity (id, company_id, user_id, action, entity_type, entity_id, summary_enc, meta_enc, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uid(), companyId, userId, action, entityType, entityId, encrypt(summary), meta ? encryptJSON(meta) : null, now());
}

export function activityRow(r) {
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name || null,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    summary: decrypt(r.summary_enc),
    meta: decryptJSON(r.meta_enc, null),
    createdAt: r.created_at,
  };
}
