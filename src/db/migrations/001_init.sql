-- High Vault Academy — initial schema
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext NOT NULL UNIQUE,
  password_hash     text NOT NULL,
  first_name        text NOT NULL,
  last_name         text NOT NULL,
  phone             text,
  role              text NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
  email_verified_at timestamptz,
  mfa_secret_enc    text,
  mfa_enabled_at    timestamptz,
  mfa_last_step     bigint,
  failed_logins     integer NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  active_session_id text,
  disabled_at       timestamptz,
  last_login_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('verify', 'reset')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON email_tokens (user_id, purpose);

CREATE TABLE courses (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                       text NOT NULL UNIQUE,
  title                      text NOT NULL,
  subtitle                   text NOT NULL DEFAULT '',
  description_md             text NOT NULL DEFAULT '',
  highlights                 jsonb NOT NULL DEFAULT '[]',
  outcomes                   jsonb NOT NULL DEFAULT '[]',
  faqs                       jsonb NOT NULL DEFAULT '[]',
  price_cents                integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  currency                   text NOT NULL DEFAULT 'cad',
  duration_minutes           integer NOT NULL DEFAULT 60,
  language                   text NOT NULL DEFAULT 'English',
  is_published               boolean NOT NULL DEFAULT false,
  pass_mark                  integer NOT NULL DEFAULT 80 CHECK (pass_mark BETWEEN 1 AND 100),
  exam_question_count        integer NOT NULL DEFAULT 20 CHECK (exam_question_count > 0),
  exam_time_limit_minutes    integer NOT NULL DEFAULT 30 CHECK (exam_time_limit_minutes > 0),
  max_attempts               integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  attempt_cooldown_minutes   integer NOT NULL DEFAULT 60 CHECK (attempt_cooldown_minutes >= 0),
  max_focus_violations       integer NOT NULL DEFAULT 3 CHECK (max_focus_violations >= 0),
  require_fullscreen         boolean NOT NULL DEFAULT true,
  certificate_validity_months integer NOT NULL DEFAULT 36 CHECK (certificate_validity_months >= 0),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE modules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id  uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title      text NOT NULL,
  position   integer NOT NULL DEFAULT 0
);
CREATE INDEX ON modules (course_id, position);

CREATE TABLE lessons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id   uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  title       text NOT NULL,
  content_md  text NOT NULL DEFAULT '',
  video_url   text,
  min_seconds integer NOT NULL DEFAULT 60 CHECK (min_seconds >= 0),
  position    integer NOT NULL DEFAULT 0
);
CREATE INDEX ON lessons (module_id, position);

CREATE TABLE enrollments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id    uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  source       text NOT NULL DEFAULT 'self' CHECK (source IN ('self', 'payment', 'admin')),
  payment_ref  text,
  extra_attempts integer NOT NULL DEFAULT 0,
  enrolled_at  timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (user_id, course_id)
);

CREATE TABLE lesson_progress (
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id         uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  seconds_spent     integer NOT NULL DEFAULT 0,
  last_heartbeat_at timestamptz,
  first_viewed_at   timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  PRIMARY KEY (user_id, lesson_id)
);

CREATE TABLE questions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  module_id   uuid REFERENCES modules(id) ON DELETE SET NULL,
  prompt      text NOT NULL,
  kind        text NOT NULL DEFAULT 'single' CHECK (kind IN ('single', 'multi')),
  explanation text NOT NULL DEFAULT '',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON questions (course_id) WHERE is_active;

CREATE TABLE question_options (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  body        text NOT NULL,
  is_correct  boolean NOT NULL DEFAULT false,
  position    integer NOT NULL DEFAULT 0
);
CREATE INDEX ON question_options (question_id);

CREATE TABLE exam_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id        uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'in_progress'
                     CHECK (status IN ('in_progress', 'submitted', 'voided')),
  question_ids     uuid[] NOT NULL,
  option_order     jsonb NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  submitted_at     timestamptz,
  score_percent    integer,
  correct_count    integer,
  passed           boolean,
  auto_submitted   text,
  focus_violations integer NOT NULL DEFAULT 0,
  ip               text,
  user_agent       text,
  void_reason      text
);
-- Only one exam in progress per learner per course, enforced by the database.
CREATE UNIQUE INDEX one_open_attempt ON exam_attempts (user_id, course_id) WHERE status = 'in_progress';
CREATE INDEX ON exam_attempts (course_id, started_at DESC);

CREATE TABLE attempt_answers (
  attempt_id   uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
  question_id  uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  option_ids   uuid[] NOT NULL DEFAULT '{}',
  answered_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attempt_id, question_id)
);

CREATE TABLE integrity_events (
  id          bigserial PRIMARY KEY,
  attempt_id  uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  counted     boolean NOT NULL DEFAULT false,
  detail      text,
  ip          text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON integrity_events (attempt_id);

CREATE TABLE certificates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id     uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  attempt_id    uuid REFERENCES exam_attempts(id) ON DELETE SET NULL,
  full_name     text NOT NULL,
  course_title  text NOT NULL,
  score_percent integer NOT NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  revoked_at    timestamptz,
  revoke_reason text
);
CREATE INDEX ON certificates (user_id);

CREATE TABLE payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id         uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  stripe_session_id text NOT NULL UNIQUE,
  amount_cents      integer NOT NULL,
  currency          text NOT NULL,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  paid_at           timestamptz
);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  action     text NOT NULL,
  entity     text,
  entity_id  text,
  meta       jsonb NOT NULL DEFAULT '{}',
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (created_at DESC);

-- Session store (connect-pg-simple)
CREATE TABLE session (
  sid    varchar NOT NULL PRIMARY KEY,
  sess   json NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX session_expire_idx ON session (expire);
