import { Router } from 'express';
import { many, one, query } from '../db/pool.js';
import { requireAuth } from '../lib/auth.js';
import { config } from '../config.js';
import { answerQuiz, courseOutline, examStatus, itemUrl, quizState, startAttempt } from '../lib/exam.js';
import { renderCertificate } from '../lib/certificate.js';
import { apiLimiter } from '../lib/limits.js';
import { renderMarkdown } from '../lib/markdown.js';
import { videoSource } from '../lib/video.js';
import { flash } from '../lib/view-helpers.js';

const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCKED_MESSAGE = 'Finish the earlier chapters and quizzes first. Modules unlock in order.';

/** Loads the course and the learner's enrollment, or redirects and returns null. */
async function enrolledCourse(req, res) {
  const course = await one('SELECT * FROM courses WHERE slug = $1', [req.params.slug]);
  const enrollment = course
    ? await one('SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2', [req.user.id, course.id])
    : null;
  if (!enrollment) {
    res.redirect(course?.is_published ? `/course/${course.slug}#enroll` : '/dashboard');
    return null;
  }
  return { course, enrollment };
}

const afterItem = (slug, outline, index) => {
  const next = outline.items[index + 1];
  return next ? itemUrl(slug, next) : `/learn/${slug}/exam`;
};

router.get('/dashboard', requireAuth, async (req, res) => {
  const enrollments = await many(
    `SELECT e.*, c.slug, c.title, c.subtitle, c.duration_minutes FROM enrollments e
       JOIN courses c ON c.id = e.course_id WHERE e.user_id = $1 ORDER BY e.enrolled_at DESC`,
    [req.user.id],
  );
  for (const e of enrollments) {
    e.outline = await courseOutline(e.course_id, req.user.id);
    e.certificate = await one(
      `SELECT * FROM certificates WHERE user_id = $1 AND course_id = $2 ORDER BY issued_at DESC LIMIT 1`,
      [req.user.id, e.course_id],
    );
    e.underReview = !e.certificate && Boolean(await one(
      `SELECT 1 FROM exam_attempts WHERE user_id = $1 AND course_id = $2 AND review_status = 'pending'`,
      [req.user.id, e.course_id],
    ));
    e.next = e.outline.next;
    e.nextUrl = e.next ? itemUrl(e.slug, e.next) : null;
  }
  const available = await many(
    `SELECT * FROM courses WHERE is_published AND id NOT IN (SELECT course_id FROM enrollments WHERE user_id = $1) ORDER BY created_at`,
    [req.user.id],
  );
  res.render('learn/dashboard', { title: 'My learning', enrollments, available });
});

router.get('/learn/:slug', requireAuth, async (req, res) => {
  const ctx = await enrolledCourse(req, res);
  if (!ctx) return;
  const outline = await courseOutline(ctx.course.id, req.user.id);
  const status = await examStatus(req.user, ctx.course);
  res.render('learn/course', { title: ctx.course.title, course: ctx.course, outline, status, itemUrl });
});

router.get('/learn/:slug/lessons/:lessonId', requireAuth, async (req, res) => {
  if (!UUID.test(req.params.lessonId)) return res.redirect(`/learn/${req.params.slug}`);
  const ctx = await enrolledCourse(req, res);
  if (!ctx) return;
  const outline = await courseOutline(ctx.course.id, req.user.id);
  const entry = outline.items.find((i) => i.type === 'lesson' && i.id === req.params.lessonId);
  if (!entry) return res.redirect(`/learn/${ctx.course.slug}`);
  if (!entry.unlocked) {
    flash(req, 'warn', LOCKED_MESSAGE);
    return res.redirect(`/learn/${ctx.course.slug}`);
  }
  const lesson = await one('SELECT * FROM lessons WHERE id = $1', [entry.id]);
  await query(
    `INSERT INTO lesson_progress (user_id, lesson_id, last_heartbeat_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id, lesson_id) DO UPDATE SET last_heartbeat_at = now()`,
    [req.user.id, lesson.id],
  );
  const prev = outline.items[entry.index - 1] ?? null;
  const next = outline.items[entry.index + 1] ?? null;
  res.render('learn/lesson', {
    title: lesson.title,
    course: ctx.course,
    outline,
    lesson,
    entry,
    itemUrl,
    html: renderMarkdown(lesson.content_md),
    video: videoSource(lesson.video_url),
    prev,
    next,
    chapterNumber: outline.lessons.findIndex((l) => l.id === lesson.id) + 1,
  });
});

async function lessonForUser(userId, lessonId) {
  if (!UUID.test(lessonId)) return null;
  return one(
    `SELECT l.id, l.min_seconds, c.id AS course_id, c.slug, lp.seconds_spent, lp.last_heartbeat_at, lp.completed_at
       FROM lessons l JOIN modules m ON m.id = l.module_id JOIN courses c ON c.id = m.course_id
       JOIN enrollments e ON e.course_id = c.id AND e.user_id = $1
       LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $1
      WHERE l.id = $2`,
    [userId, lessonId],
  );
}

/**
 * Study-time heartbeat, sent every 15s while the lesson tab is visible.
 * Credit is capped by real elapsed server time, so it can't be faked by spamming requests.
 */
router.post('/learn/lessons/:lessonId/heartbeat', requireAuth, apiLimiter, async (req, res) => {
  const lesson = await lessonForUser(req.user.id, req.params.lessonId);
  if (!lesson) return res.status(404).json({ error: 'Not found' });
  const row = await one(
    `INSERT INTO lesson_progress (user_id, lesson_id, last_heartbeat_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id, lesson_id) DO UPDATE SET
       seconds_spent = lesson_progress.seconds_spent + CASE
         WHEN lesson_progress.last_heartbeat_at > now() - interval '45 seconds'
         THEN LEAST(30, floor(extract(epoch FROM now() - lesson_progress.last_heartbeat_at)))::int
         ELSE 0 END,
       last_heartbeat_at = now()
     RETURNING seconds_spent`,
    [req.user.id, lesson.id],
  );
  res.json({ seconds: row.seconds_spent, required: lesson.min_seconds });
});

router.post('/learn/lessons/:lessonId/complete', requireAuth, async (req, res) => {
  const lesson = await lessonForUser(req.user.id, req.params.lessonId);
  if (!lesson) return res.redirect('/dashboard');
  const outline = await courseOutline(lesson.course_id, req.user.id);
  const entry = outline.items.find((i) => i.type === 'lesson' && i.id === lesson.id);
  if (!entry.unlocked) return res.redirect(`/learn/${lesson.slug}`);
  if (!lesson.completed_at) {
    const spent = lesson.seconds_spent ?? 0;
    if (spent < lesson.min_seconds) {
      flash(req, 'warn', `Spend a little more time on this chapter (${Math.ceil((lesson.min_seconds - spent) / 60)} min left) before moving on.`);
      return res.redirect(`/learn/${lesson.slug}/lessons/${lesson.id}`);
    }
    await query('UPDATE lesson_progress SET completed_at = now() WHERE user_id = $1 AND lesson_id = $2', [req.user.id, lesson.id]);
  }
  res.redirect(afterItem(lesson.slug, outline, entry.index));
});

// ---------- Module quizzes: answer correctly to move on; not timed or monitored ----------

async function quizContext(req, res) {
  if (!UUID.test(req.params.moduleId)) {
    res.redirect(`/learn/${req.params.slug}`);
    return null;
  }
  const ctx = await enrolledCourse(req, res);
  if (!ctx) return null;
  const outline = await courseOutline(ctx.course.id, req.user.id);
  const entry = outline.items.find((i) => i.type === 'quiz' && i.module_id === req.params.moduleId);
  if (!entry) {
    res.redirect(`/learn/${ctx.course.slug}`);
    return null;
  }
  if (!entry.unlocked) {
    flash(req, 'warn', LOCKED_MESSAGE);
    res.redirect(`/learn/${ctx.course.slug}`);
    return null;
  }
  return { ...ctx, outline, entry };
}

router.get('/learn/:slug/modules/:moduleId/quiz', requireAuth, async (req, res) => {
  const ctx = await quizContext(req, res);
  if (!ctx) return;
  const state = await quizState(ctx.entry.module_id, req.user.id);
  // Feedback from the answer just submitted (set by the POST, shown once).
  const fb = req.session.quizFeedback?.moduleId === ctx.entry.module_id ? req.session.quizFeedback : null;
  delete req.session.quizFeedback;
  const justAnswered = fb?.correct ? state.questions.find((q) => q.id === fb.questionId) : null;
  const question = justAnswered ?? state.current;
  res.render('learn/quiz', {
    title: `Module ${ctx.entry.moduleNumber} quiz`,
    course: ctx.course,
    outline: ctx.outline,
    entry: ctx.entry,
    itemUrl,
    question,
    number: question ? state.questions.indexOf(question) + 1 : state.questions.length,
    total: state.questions.length,
    feedback: fb,
    complete: !state.current && !justAnswered,
    nextUrl: afterItem(ctx.course.slug, ctx.outline, ctx.entry.index),
    isLast: ctx.entry.index === ctx.outline.items.length - 1,
  });
});

router.post('/learn/:slug/modules/:moduleId/quiz', requireAuth, apiLimiter, async (req, res) => {
  const ctx = await quizContext(req, res);
  if (!ctx) return;
  const back = `/learn/${ctx.course.slug}/modules/${ctx.entry.module_id}/quiz`;
  const questionId = String(req.body.question_id ?? '');
  const raw = req.body.option;
  const optionIds = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String).filter((id) => UUID.test(id));
  if (!UUID.test(questionId)) return res.redirect(back);
  const result = await answerQuiz(ctx.entry.module_id, req.user.id, questionId, optionIds);
  if (result.error === 'empty') flash(req, 'warn', 'Choose an answer first.');
  if (!result.error) req.session.quizFeedback = { moduleId: ctx.entry.module_id, questionId, correct: result.correct, chosen: result.chosen };
  res.redirect(back);
});

// ---------- Exam lobby ----------
router.get('/learn/:slug/exam', requireAuth, async (req, res) => {
  const ctx = await enrolledCourse(req, res);
  if (!ctx) return;
  const status = await examStatus(req.user, ctx.course);
  res.render('learn/exam-lobby', { title: `Final exam — ${ctx.course.title}`, course: ctx.course, status, retentionDays: config.PROCTOR_RETENTION_DAYS });
});

const EXAM_PLEDGES = ['agree_alone', 'agree_devices', 'agree_rules', 'agree_recording'];

router.post('/learn/:slug/exam/start', requireAuth, async (req, res) => {
  const ctx = await enrolledCourse(req, res);
  if (!ctx) return;
  const pledges = ctx.course.proctoring_required ? EXAM_PLEDGES : ['agree_rules'];
  if (!pledges.every((p) => req.body[p] === 'on')) {
    flash(req, 'warn', 'Confirm each exam condition to continue.');
    return res.redirect(`/learn/${ctx.course.slug}/exam`);
  }
  const result = await startAttempt(req.user, ctx.course, { ip: req.ip, userAgent: req.get('user-agent') });
  if (result.attemptId) return res.redirect(`/exam/${result.attemptId}`);
  if (result.error === 'in_progress') {
    const open = await one(
      `SELECT id FROM exam_attempts WHERE user_id = $1 AND course_id = $2 AND status IN ('checkin', 'in_progress')`,
      [req.user.id, ctx.course.id],
    );
    if (open) return res.redirect(`/exam/${open.id}`);
  }
  flash(req, 'warn', 'The exam is not available right now.');
  res.redirect(`/learn/${ctx.course.slug}/exam`);
});

// ---------- Certificates ----------
router.get('/certificates/:code.pdf', requireAuth, async (req, res) => {
  const cert = await one('SELECT * FROM certificates WHERE code = $1', [String(req.params.code).toUpperCase()]);
  if (!cert || (cert.user_id !== req.user.id && req.user.role !== 'admin')) {
    return res.status(404).render('error', { title: 'Page not found', status: 404, message: 'Certificate not found.' });
  }
  if (cert.revoked_at && req.user.role !== 'admin') {
    return res.status(410).render('error', { title: 'Certificate revoked', status: 410, message: 'This certificate has been revoked.' });
  }
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="HighVault-Certificate-${cert.code}.pdf"`,
    'Cache-Control': 'private, no-store',
  });
  await renderCertificate(cert, res);
});

export default router;
