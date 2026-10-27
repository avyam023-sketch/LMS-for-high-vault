-- Module quizzes, proctored exam check-in, and identity review before certification.

-- Questions belong either to the final-exam bank or to a module quiz.
ALTER TABLE questions ADD COLUMN pool text NOT NULL DEFAULT 'exam' CHECK (pool IN ('exam', 'quiz'));
ALTER TABLE questions ADD COLUMN position integer NOT NULL DEFAULT 0;
DROP INDEX IF EXISTS questions_course_id_idx;
CREATE INDEX questions_pool_idx ON questions (course_id, pool) WHERE is_active;
CREATE INDEX questions_module_quiz_idx ON questions (module_id, position) WHERE pool = 'quiz';

-- Quiz progress: a question counts once the learner has answered it correctly.
CREATE TABLE quiz_answers (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  tries       integer NOT NULL DEFAULT 0,
  correct_at  timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, question_id)
);

-- Proctoring settings per course.
ALTER TABLE courses ADD COLUMN proctoring_required boolean NOT NULL DEFAULT true;
ALTER TABLE courses ADD COLUMN identity_review_required boolean NOT NULL DEFAULT true;

-- Attempts now begin with an identity and room check-in before the timer starts.
ALTER TABLE exam_attempts DROP CONSTRAINT exam_attempts_status_check;
ALTER TABLE exam_attempts ADD CONSTRAINT exam_attempts_status_check
  CHECK (status IN ('checkin', 'in_progress', 'submitted', 'voided'));
DROP INDEX one_open_attempt;
CREATE UNIQUE INDEX one_open_attempt ON exam_attempts (user_id, course_id) WHERE status IN ('checkin', 'in_progress');
ALTER TABLE exam_attempts ADD COLUMN checkin_started_at timestamptz;
ALTER TABLE exam_attempts ADD COLUMN review_status text NOT NULL DEFAULT 'not_required'
  CHECK (review_status IN ('not_required', 'pending', 'approved', 'rejected'));
ALTER TABLE exam_attempts ADD COLUMN reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE exam_attempts ADD COLUMN reviewed_at timestamptz;
ALTER TABLE exam_attempts ADD COLUMN review_note text;
CREATE INDEX exam_attempts_review_idx ON exam_attempts (review_status) WHERE review_status = 'pending';

-- Proctoring evidence: ID photo, face photo, room scan, periodic snapshots.
-- Payloads are encrypted (AES-256-GCM) before they reach the database.
CREATE TABLE proctor_media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id  uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('face', 'id', 'room_scan', 'snapshot')),
  mime        text NOT NULL,
  byte_size   integer NOT NULL,
  data        bytea NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proctor_media_attempt_idx ON proctor_media (attempt_id, kind, created_at);
