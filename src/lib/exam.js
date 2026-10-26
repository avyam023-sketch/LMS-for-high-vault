import { many, one, query, tx } from '../db/pool.js';
import { certificateCode, shuffle } from './crypto.js';

/** Seconds of leeway after the deadline for answers already in flight. */
export const GRACE_SECONDS = 20;
/** Events that count toward the focus-violation limit. Everything else is logged only. */
export const COUNTED_EVENTS = new Set(['tab_hidden', 'window_blur', 'fullscreen_exit']);
export const LOGGED_EVENTS = new Set([...COUNTED_EVENTS, 'copy', 'paste', 'context_menu', 'print', 'devtools', 'shortcut']);

function sameSet(a = [], b = []) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** Ordered lessons for a course with this learner's progress. */
export async function courseOutline(courseId, userId) {
  const rows = await many(
    `SELECT m.id AS module_id, m.title AS module_title, m.position AS module_position,
            l.id, l.title, l.min_seconds, l.position,
            lp.seconds_spent, lp.completed_at
       FROM modules m
       JOIN lessons l ON l.module_id = m.id
       LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $2
      WHERE m.course_id = $1
      ORDER BY m.position, m.title, l.position, l.title`,
    [courseId, userId ?? '00000000-0000-0000-0000-000000000000'],
  );
  const modules = [];
  let previousDone = true;
  for (const r of rows) {
    let mod = modules.at(-1);
    if (!mod || mod.id !== r.module_id) {
      mod = { id: r.module_id, title: r.module_title, lessons: [] };
      modules.push(mod);
    }
    const done = Boolean(r.completed_at);
    // Lessons unlock in order: the next lesson opens once the previous one is complete.
    mod.lessons.push({ ...r, done, unlocked: previousDone });
    previousDone = done;
  }
  const lessons = modules.flatMap((m) => m.lessons);
  const completed = lessons.filter((l) => l.done).length;
  return {
    modules,
    lessons,
    completed,
    total: lessons.length,
    percent: lessons.length ? Math.round((completed / lessons.length) * 100) : 0,
    allDone: lessons.length > 0 && completed === lessons.length,
  };
}

export async function validCertificate(userId, courseId) {
  return one(
    `SELECT * FROM certificates
      WHERE user_id = $1 AND course_id = $2 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY issued_at DESC LIMIT 1`,
    [userId, courseId],
  );
}

/** Works out whether a learner may start the exam now, and if not, why. */
export async function examStatus(user, course) {
  const enrollment = await one('SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2', [user.id, course.id]);
  if (!enrollment) return { eligible: false, reason: 'not_enrolled' };

  const open = await one(
    `SELECT id, expires_at FROM exam_attempts WHERE user_id = $1 AND course_id = $2 AND status = 'in_progress'`,
    [user.id, course.id],
  );
  if (open) {
    if (new Date(open.expires_at).getTime() + GRACE_SECONDS * 1000 < Date.now()) {
      await finalizeAttempt(open.id, 'time');
    } else {
      return { eligible: false, reason: 'in_progress', attemptId: open.id, enrollment };
    }
  }

  const certificate = await validCertificate(user.id, course.id);
  const attempts = await many(
    `SELECT id, status, score_percent, passed, submitted_at, started_at, auto_submitted
       FROM exam_attempts WHERE user_id = $1 AND course_id = $2 ORDER BY started_at DESC`,
    [user.id, course.id],
  );
  const allowed = course.max_attempts + enrollment.extra_attempts;
  const base = { enrollment, attempts, certificate, attemptsUsed: attempts.length, attemptsAllowed: allowed };

  if (certificate) return { ...base, eligible: false, reason: 'certified' };
  const outline = await courseOutline(course.id, user.id);
  if (!outline.allDone) return { ...base, eligible: false, reason: 'lessons_incomplete', outline };
  if (attempts.length >= allowed) return { ...base, eligible: false, reason: 'no_attempts_left' };
  const last = attempts[0];
  if (last?.submitted_at && course.attempt_cooldown_minutes > 0) {
    const availableAt = new Date(new Date(last.submitted_at).getTime() + course.attempt_cooldown_minutes * 60_000);
    if (availableAt > new Date()) return { ...base, eligible: false, reason: 'cooldown', availableAt };
  }
  const bankSize = (await one('SELECT count(*)::int AS n FROM questions WHERE course_id = $1 AND is_active', [course.id])).n;
  if (bankSize === 0) return { ...base, eligible: false, reason: 'no_questions' };
  return { ...base, eligible: true, questionCount: Math.min(bankSize, course.exam_question_count) };
}

/** Creates a fresh attempt with questions and answer options drawn and shuffled on the server. */
export async function startAttempt(user, course, { ip, userAgent }) {
  const status = await examStatus(user, course);
  if (!status.eligible) return { error: status.reason, attemptId: status.attemptId };

  const bank = await many(
    `SELECT q.id, array_agg(o.id) AS option_ids
       FROM questions q JOIN question_options o ON o.question_id = q.id
      WHERE q.course_id = $1 AND q.is_active
      GROUP BY q.id`,
    [course.id],
  );
  const picked = shuffle(bank).slice(0, course.exam_question_count);
  const optionOrder = Object.fromEntries(picked.map((q) => [q.id, shuffle(q.option_ids)]));
  try {
    const attempt = await one(
      `INSERT INTO exam_attempts (user_id, course_id, question_ids, option_order, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5), $6, $7) RETURNING id`,
      [user.id, course.id, picked.map((q) => q.id), optionOrder, course.exam_time_limit_minutes, ip, userAgent?.slice(0, 400)],
    );
    return { attemptId: attempt.id };
  } catch (err) {
    if (err.code === '23505') return { error: 'in_progress' }; // double-click / second tab
    throw err;
  }
}

export async function loadAttempt(attemptId, userId) {
  if (!/^[0-9a-f-]{36}$/i.test(attemptId)) return null;
  return one(
    `SELECT a.*, c.title AS course_title, c.slug AS course_slug, c.pass_mark, c.max_focus_violations,
            c.require_fullscreen, c.exam_time_limit_minutes
       FROM exam_attempts a JOIN courses c ON c.id = a.course_id
      WHERE a.id = $1 AND a.user_id = $2`,
    [attemptId, userId],
  );
}

export const isExpired = (attempt) => new Date(attempt.expires_at).getTime() + GRACE_SECONDS * 1000 < Date.now();

/** The exam paper as the learner sees it. Never includes which options are correct. */
export async function examPaper(attempt) {
  const questions = await many('SELECT id, prompt, kind FROM questions WHERE id = ANY($1)', [attempt.question_ids]);
  const options = await many('SELECT id, question_id, body FROM question_options WHERE question_id = ANY($1)', [
    attempt.question_ids,
  ]);
  const answers = await many('SELECT question_id, option_ids FROM attempt_answers WHERE attempt_id = $1', [attempt.id]);
  const byId = new Map(options.map((o) => [o.id, o]));
  const answered = new Map(answers.map((a) => [a.question_id, a.option_ids]));
  const qById = new Map(questions.map((q) => [q.id, q]));
  return attempt.question_ids
    .filter((id) => qById.has(id))
    .map((id, i) => ({
      number: i + 1,
      id,
      prompt: qById.get(id).prompt,
      kind: qById.get(id).kind,
      options: (attempt.option_order[id] ?? []).filter((oid) => byId.has(oid)).map((oid) => ({ id: oid, body: byId.get(oid).body })),
      selected: answered.get(id) ?? [],
    }));
}

export async function saveAnswer(attempt, questionId, optionIds) {
  if (!attempt.question_ids.includes(questionId)) return 'Question is not part of this exam.';
  const allowed = new Set(attempt.option_order[questionId] ?? []);
  const unique = [...new Set(optionIds)];
  if (!unique.every((id) => allowed.has(id))) return 'Invalid answer.';
  const q = await one('SELECT kind FROM questions WHERE id = $1', [questionId]);
  if (q.kind === 'single' && unique.length > 1) return 'Choose one answer.';
  await query(
    `INSERT INTO attempt_answers (attempt_id, question_id, option_ids) VALUES ($1, $2, $3)
     ON CONFLICT (attempt_id, question_id) DO UPDATE SET option_ids = EXCLUDED.option_ids, answered_at = now()`,
    [attempt.id, questionId, unique],
  );
  return null;
}

/** Logs a proctoring event. Returns { violations, terminated }. */
export async function recordIntegrityEvent(attempt, kind, detail, ip) {
  let counted = false;
  if (COUNTED_EVENTS.has(kind)) {
    // A tab switch fires blur + hidden together: count once per 3-second window.
    const recent = await one(
      `SELECT 1 FROM integrity_events WHERE attempt_id = $1 AND counted AND occurred_at > now() - interval '3 seconds'`,
      [attempt.id],
    );
    counted = !recent;
  }
  await query('INSERT INTO integrity_events (attempt_id, kind, counted, detail, ip) VALUES ($1, $2, $3, $4, $5)', [
    attempt.id,
    kind,
    counted,
    detail?.slice(0, 300) ?? null,
    ip,
  ]);
  if (!counted) return { violations: attempt.focus_violations, terminated: false };
  const { focus_violations: violations } = await one(
    'UPDATE exam_attempts SET focus_violations = focus_violations + 1 WHERE id = $1 RETURNING focus_violations',
    [attempt.id],
  );
  const limit = attempt.max_focus_violations;
  if (limit > 0 && violations > limit) {
    await finalizeAttempt(attempt.id, 'integrity');
    return { violations, terminated: true };
  }
  return { violations, terminated: false };
}

/**
 * Grades and closes an attempt (idempotent). A question scores only when the selected
 * options exactly match the correct set. Issues the certificate on a pass.
 */
export async function finalizeAttempt(attemptId, autoReason = null) {
  return tx(async (db) => {
    const { rows } = await db.query(
      `SELECT a.*, c.pass_mark, c.title AS course_title, c.certificate_validity_months
         FROM exam_attempts a JOIN courses c ON c.id = a.course_id
        WHERE a.id = $1 FOR UPDATE OF a`,
      [attemptId],
    );
    const attempt = rows[0];
    if (!attempt || attempt.status !== 'in_progress') return attempt;

    const { rows: key } = await db.query(
      `SELECT q.id, coalesce(array_agg(o.id ORDER BY o.id) FILTER (WHERE o.is_correct), '{}') AS correct
         FROM questions q LEFT JOIN question_options o ON o.question_id = q.id
        WHERE q.id = ANY($1) GROUP BY q.id`,
      [attempt.question_ids],
    );
    const { rows: answers } = await db.query('SELECT question_id, option_ids FROM attempt_answers WHERE attempt_id = $1', [
      attemptId,
    ]);
    const given = new Map(answers.map((a) => [a.question_id, a.option_ids]));
    let correct = 0;
    for (const q of key) {
      if (sameSet(given.get(q.id), q.correct)) correct++;
    }
    const total = attempt.question_ids.length;
    const score = total ? Math.round((correct / total) * 100) : 0;
    const passed = score >= attempt.pass_mark;

    const { rows: updated } = await db.query(
      `UPDATE exam_attempts SET status = 'submitted', submitted_at = now(), score_percent = $2, correct_count = $3,
              passed = $4, auto_submitted = $5
        WHERE id = $1 RETURNING *`,
      [attemptId, score, correct, passed, autoReason],
    );

    if (passed) {
      const { rows: u } = await db.query('SELECT first_name, last_name FROM users WHERE id = $1', [attempt.user_id]);
      const months = attempt.certificate_validity_months;
      await db.query(
        `INSERT INTO certificates (code, user_id, course_id, attempt_id, full_name, course_title, score_percent, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8::int > 0 THEN now() + make_interval(months => $8::int) END)`,
        [certificateCode(), attempt.user_id, attempt.course_id, attemptId, `${u[0].first_name} ${u[0].last_name}`,
          attempt.course_title, score, months],
      );
      await db.query('UPDATE enrollments SET completed_at = now() WHERE user_id = $1 AND course_id = $2', [
        attempt.user_id,
        attempt.course_id,
      ]);
    }
    return updated[0];
  });
}

/** Per-module breakdown for the results page — shows weak areas without revealing answers. */
export async function moduleBreakdown(attempt) {
  const rows = await many(
    `SELECT q.id, coalesce(m.title, 'General') AS module,
            coalesce(array_agg(o.id ORDER BY o.id) FILTER (WHERE o.is_correct), '{}') AS correct
       FROM questions q LEFT JOIN modules m ON m.id = q.module_id
       LEFT JOIN question_options o ON o.question_id = q.id
      WHERE q.id = ANY($1) GROUP BY q.id, m.title, m.position ORDER BY m.position NULLS LAST`,
    [attempt.question_ids],
  );
  const answers = await many('SELECT question_id, option_ids FROM attempt_answers WHERE attempt_id = $1', [attempt.id]);
  const given = new Map(answers.map((a) => [a.question_id, a.option_ids]));
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.module) ?? { module: r.module, total: 0, correct: 0 };
    g.total++;
    if (sameSet(given.get(r.id), r.correct)) g.correct++;
    groups.set(r.module, g);
  }
  return [...groups.values()];
}
