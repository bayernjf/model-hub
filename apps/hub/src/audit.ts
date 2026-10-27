import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from './ids.js';

export type AuditResult = 'success' | 'failure' | 'denied';

export interface AuditEntry {
  actor: string;
  action: string;
  targetType: string;
  targetId?: string;
  result: AuditResult;
  detail?: string;
  ip?: string;
}

// Append an entry to admin_audit. Failures to audit must not throw into the
// request handler, but they are logged.
export function writeAudit(db: DatabaseSync, entry: AuditEntry): void {
  try {
    db.prepare(
      `INSERT INTO admin_audit
         (id, actor, action, target_type, target_id, result, detail, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId('aud'),
      entry.actor,
      entry.action,
      entry.targetType,
      entry.targetId ?? null,
      entry.result,
      entry.detail ?? null,
      entry.ip ?? null,
      nowIso(),
    );
  } catch (err) {
    console.error('failed to write audit entry:', err);
  }
}
