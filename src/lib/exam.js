import { many, one, query, tx } from '../db/pool.js';
import { certificateCode, shuffle } from './crypto.js';

/** Seconds of leeway after the deadline for answers already in flight. */
export const GRACE_SECONDS = 20;
/** Minutes a learner has to finish the identity and room check-in before it lapses. */
export const CHECKIN_MINUTES = 30;
/**
 * Events that count toward the warning limit (and can end the exam automatically). These are
 * signals the browser reports reliably. Face detection and noise can misfire (lighting, a poster,
 * traffic outside), so those are logged with snapshots for the human reviewer instead.
 */
export const COUNTED_EVENTS = new Set(['tab_hidden', 'window_blur', 'fullscreen_exit', 'camera_off', 'second_screen']);
export const REVIEW_EVENTS = new Set(['no_face', 'multiple_faces', 'noise', 'face_check_skipped', 'detector_unavailable']);
export const LOGGED_EVENTS = new Set([
  ...COUNTED_EVENTS, ...REVIEW_EVENTS, 'copy', 'paste', 'context_menu', 'print', 'devtools', 'shortcut', 'camera_restored',
]);
/** Media a proctored attempt must have before the exam can begin. */
export const REQUIRED_CHECKIN_MEDIA = ['face', 'id', 'room_scan'];

const NO_USER = '00000000-0000-0000-0000-000000000000';

function sameSet(a = [], b = []) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/**
 * The course as a learner moves through it: each module holds its chapter(s) followed by its
 * quiz. Items unlock strictly in order — a chapter, then its quiz, then the next module.
 */
export async function courseOutline(courseId, userId) {
  const uid = userId ?? NO_USER;
  const lessonRows = await many(
    `SELECT m.id AS module_id, m.title AS module_title, l.id, l.title, l.min_seconds, l.video_url IS NOT NULL AS has_video,
            lp.seconds_spent, lp.completed_at
       FROM modules m
       JOIN lessons l ON l.module_id = m.id
       LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $2
      WHERE m.course_id = $1
      ORDER BY m.position, m.title, l.position, l.title`,
    [courseId, uid],
  );
  const quizRows = await many(
    `SELECT q.module_id, count(*)::int AS total, count(qa.correct_at)::int AS correct
       FROM questions q LEFT JOIN quiz_answers qa ON qa.question_id = q.id AND qa.user_id = $2
      WHERE q.course_id = $1 AND q.pool = 'quiz' AND q.is_active AND q.module_id IS NOT NULL
      GROUP BY q.module_id`,
    [courseId, uid],
  );
  const quizByModule = new Map(quizRows.map((r) => [r.module_id, r]));
  const allModules = await many('SELECT id, title FROM modules WHERE course_id = $1 ORDER BY position, title', [courseId]);

  const modules = allModules.map((m, i) => ({ id: m.id, title: m.title, number: i + 1, lessons: [], quiz: null }));
  const byId = new Map(modules.map((m) => [m.id, m]));
  let chapter = 0;
  for (const r of lessonRows) byId.get(r.module_id).lessons.push({ ...r, type: 'lesson', chapterNumber: ++chapter, done: Boolean(r.completed_at) });
  for (const m of modules) {
    const q = quizByModule.get(m.id);
    if (q) m.quiz = { type: 'quiz', id: m.id, module_id: m.id, title: `Module ${m.number} quiz`, total: q.total, correct: q.correct, done: q.correct >= q.total };
  }

  const items = [];
  let previousDone = true;
  for (const m of modules) {
    for (const item of [...m.lessons, ...(m.quiz ? [m.quiz] : [])]) {
      item.unlocked = previousDone;
      item.moduleNumber = m.number;
      item.index = items.length;
      items.push(item);
      previousDone = item.done;
    }
  }
  const lessons = items.filter((i) => i.type === 'lesson');
  const completed = items.filter((i) => i.done).length;
  return {
    modules: modules.filter((m) => m.lessons.length || m.quiz),
    items,
    lessons,
    completed,
    total: items.length,
    percent: items.length ? Math.round((completed / items.length) * 100) : 0,
    allDone: items.length > 0 && completed === items.length,
    next: items.find((i) => !i.done) ?? null,
  };
}

/** Where an outline item lives. */
export const itemUrl = (slug, item) =>
  item.type === 'quiz' ? `/learn/${slug}/modules/${item.module_id}/quiz` : `/learn/${slug}/lessons/${item.id}`;

export async function validCertificate(userId, courseId) {
  return one(
    `SELECT * FROM certificates
      WHERE user_id = $1 AND course_id = $2 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY issued_at DESC LIMIT 1`,
    [userId, courseId],
  );
}

/** Drops check-ins that were abandoned before the exam began. They never count as attempts. */
async function expireStaleCheckins(userId, courseId) {
  await query(
    `DELETE FROM exam_attempts WHERE user_id = $1 AND course_id = $2 AND status = 'checkin'
       AND checkin_started_at < now() - make_interval(mins => $3::int)`,
    [userId, courseId, CHECKIN_MINUTES],
  );
}

/** Works out whether a learner may start the exam now, and if not, why. */
export async function examStatus(user, course) {
  const enrollment = await one('SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2', [user.id, course.id]);
  if (!enrollment) return { eligible: false, reason: 'not_enrolled' };

  await expireStaleCheckins(user.id, course.id);
  const open = await one(
    `SELECT id, status, expires_at FROM exam_attempts WHERE user_id = $1 AND course_id = $2 AND status IN ('checkin', 'in_progress')`,
    [user.id, course.id],
  );
  if (open?.status === 'checkin') return { eligible: false, reason: 'checkin', attemptId: open.id, enrollment };
  if (open) {
    if (new Date(open.expires_at).getTime() + GRACE_SECONDS * 1000 < Date.now()) {
      await finalizeAttempt(open.id, 'time');
    } else {
      return { eligible: false, reason: 'in_progress', attemptId: open.id, enrollment };
    }
  }

  const certificate = await validCertificate(user.id, course.id);
  const attempts = await many(
    `SELECT id, status, score_percent, passed, submitted_at, started_at, auto_submitted, review_status
       FROM exam_attempts WHERE user_id = $1 AND course_id = $2 ORDER BY started_at DESC`,
    [user.id, course.id],
  );
  const allowed = course.max_attempts + enrollment.extra_attempts;
  const base = { enrollment, attempts, certificate, attemptsUsed: attempts.length, attemptsAllowed: allowed };

  if (certificate) return { ...base, eligible: false, reason: 'certified' };
  const pending = attempts.find((a) => a.review_status === 'pending');
  if (pending) return { ...base, eligible: false, reason: 'under_review', attemptId: pending.id };
  const outline = await courseOutline(course.id, user.id);
  if (!outline.allDone) return { ...base, eligible: false, reason: 'lessons_incomplete', outline };
  if (attempts.length >= allowed) return { ...base, eligible: false, reason: 'no_attempts_left' };
  const last = attempts[0];
  if (last?.submitted_at && course.attempt_cooldown_minutes > 0) {
    const availableAt = new Date(new Date(last.submitted_at).getTime() + course.attempt_cooldown_minutes * 60_000);
    if (availableAt > new Date()) return { ...base, eligible: false, reason: 'cooldown', availableAt };
  }
  const bankSize = (await one(`SELECT count(*)::int AS n FROM questions WHERE course_id = $1 AND pool = 'exam' AND is_active`, [course.id])).n;
  if (bankSize === 0) return { ...base, eligible: false, reason: 'no_questions' };
  return { ...base, eligible: true, questionCount: Math.min(bankSize, course.exam_question_count) };
}

/**
 * Creates an attempt with questions and answer options drawn and shuffled on the server.
 * Proctored courses start in 'checkin': the timer only starts once ID, face and room scan are done.
 */
export async function startAttempt(user, course, { ip, userAgent }) {
  const status = await examStatus(user, course);
  if (!status.eligible) return { error: status.reason, attemptId: status.attemptId };

  const bank = await many(
    `SELECT q.id, array_agg(o.id) AS option_ids
       FROM questions q JOIN question_options o ON o.question_id = q.id
      WHERE q.course_id = $1 AND q.pool = 'exam' AND q.is_active
      GROUP BY q.id`,
    [course.id],
  );
  const picked = shuffle(bank).slice(0, course.exam_question_count);
  const optionOrder = Object.fromEntries(picked.map((q) => [q.id, shuffle(q.option_ids)]));
  const proctored = course.proctoring_required;
  try {
    const attempt = await one(
      `INSERT INTO exam_attempts (user_id, course_id, question_ids, option_order, status, checkin_started_at, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN now() END,
               now() + make_interval(mins => CASE WHEN $6 THEN $7::int ELSE $8::int END), $9, $10) RETURNING id`,
      [user.id, course.id, picked.map((q) => q.id), optionOrder, proctored ? 'checkin' : 'in_progress', proctored,
        CHECKIN_MINUTES, course.exam_time_limit_minutes, ip, userAgent?.slice(0, 400)],
    );
    return { attemptId: attempt.id };
  } catch (err) {
    if (err.code === '23505') return { error: 'in_progress' }; // double-click / second tab
    throw err;
  }
}

/** Ends check-in and starts the clock. Refuses until the required check-in media exist. */
export async function beginAttempt(attempt) {
  const have = await many('SELECT DISTINCT kind FROM proctor_media WHERE attempt_id = $1', [attempt.id]);
  const kinds = new Set(have.map((r) => r.kind));
  const missing = REQUIRED_CHECKIN_MEDIA.filter((k) => !kinds.has(k));
  if (missing.length) return { error: 'missing_media', missing };
  const row = await one(
    `UPDATE exam_attempts SET status = 'in_progress', started_at = now(),
            expires_at = now() + make_interval(mins => $2::int)
      WHERE id = $1 AND status = 'checkin' RETURNING id`,
    [attempt.id, attempt.exam_time_limit_minutes],
  );
  return row ? { ok: true } : { error: 'not_in_checkin' };
}

export async function loadAttempt(attemptId, userId) {
  if (!/^[0-9a-f-]{36}$/i.test(attemptId)) return null;
  return one(
    `SELECT a.*, c.title AS course_title, c.slug AS course_slug, c.pass_mark, c.max_focus_violations,
            c.require_fullscreen, c.exam_time_limit_minutes, c.proctoring_required
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
  if (COUNTED_EVENTS.has(kind) && attempt.status === 'in_progress') {
    // One real-world incident often fires several events (blur + hidden): count once per 3-second window.
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

/** Issues the certificate for a passed attempt (inside a transaction). */
async function issueCertificate(db, attemptId) {
  const { rows } = await db.query(
    `SELECT a.user_id, a.course_id, a.score_percent, c.title AS course_title, c.certificate_validity_months, u.first_name, u.last_name
       FROM exam_attempts a JOIN courses c ON c.id = a.course_id JOIN users u ON u.id = a.user_id WHERE a.id = $1`,
    [attemptId],
  );
  const a = rows[0];
  const { rows: cert } = await db.query(
    `INSERT INTO certificates (code, user_id, course_id, attempt_id, full_name, course_title, score_percent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8::int > 0 THEN now() + make_interval(months => $8::int) END)
     RETURNING *`,
    [certificateCode(), a.user_id, a.course_id, attemptId, `${a.first_name} ${a.last_name}`, a.course_title, a.score_percent,
      a.certificate_validity_months],
  );
  await db.query('UPDATE enrollments SET completed_at = now() WHERE user_id = $1 AND course_id = $2', [a.user_id, a.course_id]);
  return cert[0];
}

/**
 * Grades and closes an attempt (idempotent). A question scores only when the selected
 * options exactly match the correct set. On a pass, the certificate is issued right away —
 * or, when the course requires identity review, once an administrator approves the attempt.
 */
export async function finalizeAttempt(attemptId, autoReason = null) {
  return tx(async (db) => {
    const { rows } = await db.query(
      `SELECT a.*, c.pass_mark, c.identity_review_required, c.proctoring_required
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
    const needsReview = passed && attempt.proctoring_required && attempt.identity_review_required;

    const { rows: updated } = await db.query(
      `UPDATE exam_attempts SET status = 'submitted', submitted_at = now(), score_percent = $2, correct_count = $3,
              passed = $4, auto_submitted = $5, review_status = $6
        WHERE id = $1 RETURNING *`,
      [attemptId, score, correct, passed, autoReason, needsReview ? 'pending' : 'not_required'],
    );
    if (passed && !needsReview) await issueCertificate(db, attemptId);
    return updated[0];
  });
}

/** Administrator decision on a passed, proctored attempt. Approval issues the certificate. */
export async function reviewAttempt(attemptId, reviewerId, decision, note) {
  return tx(async (db) => {
    const { rows } = await db.query(`SELECT * FROM exam_attempts WHERE id = $1 FOR UPDATE`, [attemptId]);
    const attempt = rows[0];
    if (!attempt || attempt.review_status !== 'pending') return { error: 'not_pending' };
    if (decision === 'approve') {
      await db.query(
        `UPDATE exam_attempts SET review_status = 'approved', reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $1`,
        [attemptId, reviewerId, note || null],
      );
      return { certificate: await issueCertificate(db, attemptId), attempt };
    }
    await db.query(
      `UPDATE exam_attempts SET review_status = 'rejected', status = 'voided', void_reason = $3,
              reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $1`,
      [attemptId, reviewerId, note || 'Identity or exam conditions could not be verified'],
    );
    return { attempt };
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

// ---------- Module quizzes ----------

/** Active questions of a module quiz with this learner's progress, in order. */
export async function quizState(moduleId, userId) {
  const questions = await many(
    `SELECT q.id, q.prompt, q.kind, q.explanation, qa.correct_at, coalesce(qa.tries, 0) AS tries
       FROM questions q LEFT JOIN quiz_answers qa ON qa.question_id = q.id AND qa.user_id = $2
      WHERE q.module_id = $1 AND q.pool = 'quiz' AND q.is_active
      ORDER BY q.position, q.created_at`,
    [moduleId, userId],
  );
  const options = questions.length
    ? await many('SELECT id, question_id, body, is_correct FROM question_options WHERE question_id = ANY($1) ORDER BY position', [
        questions.map((q) => q.id),
      ])
    : [];
  for (const q of questions) q.options = options.filter((o) => o.question_id === q.id);
  return { questions, current: questions.find((q) => !q.correct_at) ?? null };
}

/** Grades one quiz answer. Only the learner's current question can be answered. */
export async function answerQuiz(moduleId, userId, questionId, optionIds) {
  const { current } = await quizState(moduleId, userId);
  if (!current || current.id !== questionId) return { error: 'not_current' };
  const valid = new Set(current.options.map((o) => o.id));
  const chosen = [...new Set(optionIds)].filter((id) => valid.has(id));
  if (!chosen.length) return { error: 'empty' };
  if (current.kind === 'single' && chosen.length > 1) return { error: 'empty' };
  const correct = sameSet(chosen, current.options.filter((o) => o.is_correct).map((o) => o.id));
  await query(
    `INSERT INTO quiz_answers (user_id, question_id, tries, correct_at) VALUES ($1, $2, 1, CASE WHEN $3 THEN now() END)
     ON CONFLICT (user_id, question_id) DO UPDATE SET tries = quiz_answers.tries + 1,
       correct_at = coalesce(quiz_answers.correct_at, EXCLUDED.correct_at), updated_at = now()`,
    [userId, questionId, correct],
  );
  return { correct, chosen };
}
