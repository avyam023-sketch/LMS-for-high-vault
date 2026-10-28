import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { expiryReminderEmail } from './notify.js';

/**
 * Deletes exam evidence (ID photo, face photo, room scan, snapshots):
 * - N days after a decision (approved, rejected, failed or voided), default 30;
 * - and never later than PROCTOR_RETENTION_DAYS after upload, default 90.
 */
export async function purgeProctorMedia() {
  const { rows } = await pool.query(
    `WITH gone AS (
       DELETE FROM proctor_media pm USING exam_attempts a
        WHERE pm.attempt_id = a.id AND (
              pm.created_at < now() - make_interval(days => $1::int)
           OR (a.review_status IN ('approved', 'rejected') AND a.reviewed_at < now() - make_interval(days => $2::int))
           OR (a.review_status = 'not_required' AND a.status IN ('submitted', 'voided')
               AND a.submitted_at < now() - make_interval(days => $2::int)))
        RETURNING pm.attempt_id)
     UPDATE exam_attempts SET evidence_purged_at = now()
      WHERE id IN (SELECT DISTINCT attempt_id FROM gone) RETURNING id`,
    [config.PROCTOR_RETENTION_DAYS, config.PROCTOR_RETENTION_AFTER_DECISION_DAYS],
  );
  return rows.length;
}

/** Emails learners whose certificate expires within 60 days (once per certificate). */
export async function sendExpiryReminders() {
  const { rows } = await pool.query(
    `UPDATE certificates c SET expiry_reminder_sent_at = now()
       FROM users u
      WHERE u.id = c.user_id AND u.deleted_at IS NULL AND c.revoked_at IS NULL AND c.expiry_reminder_sent_at IS NULL
        AND c.expires_at BETWEEN now() AND now() + interval '60 days'
      RETURNING c.code, c.course_title, c.expires_at, u.email, u.first_name, u.reference`,
  );
  for (const r of rows) await expiryReminderEmail(r);
  return rows.length;
}

/** Clears expired rate-limit counters. */
export async function pruneRateLimits() {
  await pool.query('DELETE FROM rate_limits WHERE reset_at < now()');
}

export async function runMaintenance() {
  for (const [name, job] of [['purge', purgeProctorMedia], ['reminders', sendExpiryReminders], ['rate-limits', pruneRateLimits]]) {
    try {
      const n = await job();
      if (n) console.log(`[maintenance] ${name}: ${n}`);
    } catch (err) {
      console.error(`[maintenance] ${name} failed`, err);
    }
  }
}
