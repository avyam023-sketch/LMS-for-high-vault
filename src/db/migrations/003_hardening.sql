-- Least-privilege reviewers, evidence lifecycle, account deletion, shared rate limits, reminders.

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('student', 'reviewer', 'admin'));
ALTER TABLE users ADD COLUMN deleted_at timestamptz;
ALTER TABLE users ADD COLUMN password_changed_at timestamptz;

ALTER TABLE exam_attempts ADD COLUMN evidence_purged_at timestamptz;

ALTER TABLE certificates ADD COLUMN expiry_reminder_sent_at timestamptz;

-- Rate-limit counters shared by every app instance and kept across restarts.
CREATE TABLE rate_limits (
  key      text PRIMARY KEY,
  hits     integer NOT NULL,
  reset_at timestamptz NOT NULL
);
CREATE INDEX rate_limits_reset_idx ON rate_limits (reset_at);
