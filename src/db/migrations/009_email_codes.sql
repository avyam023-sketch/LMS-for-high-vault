-- Email confirmation by 6-digit code (alongside the link), with a cap on wrong guesses.
ALTER TABLE email_tokens DROP CONSTRAINT email_tokens_purpose_check;
ALTER TABLE email_tokens ADD CONSTRAINT email_tokens_purpose_check CHECK (purpose IN ('verify', 'verify_code', 'reset'));
ALTER TABLE email_tokens ADD COLUMN attempts integer NOT NULL DEFAULT 0;

-- Hosted Postgres (e.g. Supabase) installs pgcrypto in an "extensions" schema; find it there too.
ALTER FUNCTION hv_reference(text) SET search_path = pg_catalog, public, extensions;
