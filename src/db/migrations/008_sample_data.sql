-- Sample learners loaded for a live demo (SEED_SAMPLE_DATA) are marked so an admin can remove them in one go.
ALTER TABLE users ADD COLUMN is_sample boolean NOT NULL DEFAULT false;
CREATE INDEX users_sample_idx ON users (is_sample) WHERE is_sample;
