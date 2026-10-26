import { Router } from 'express';
import { many, one, query } from '../db/pool.js';
import { requireAuth } from '../lib/auth.js';
import { courseOutline, examStatus, startAttempt } from '../lib/exam.js';
import { renderCertificate } from '../lib/certificate.js';
import { apiLimiter } from '../lib/limits.js';
import { embedUrl, renderMarkdown } from '../lib/markdown.js';
import { flash } from '../lib/view-helpers.js';

const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    e.next = e.outline.lessons.find((l) => !l.done);
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
  res.render('learn/course', { title: ctx.course.title, course: ctx.course, outline, status });
});

router.get('/learn/:slug/lessons/:lessonId', requireAuth, async (req, res) => {
  if (!UUID.test(req.params.lessonId)) return res.redirect(`/learn/${req.params.slug}`);
  const ctx = await enrolledCourse(req, res);
  if (!ctx) return;
  const outline = await courseOutline(ctx.course.id, req.user.id);
  const index = outline.lessons.findIndex((l) => l.id === req.params.lessonId);
  const entry = outline.lessons[index];
  if (!entry) return res.redirect(`/learn/${ctx.course.slug}`);
  if (!entry.unlocked) {
    flash(req, 'warn', 'Finish the earlier lessons first. Lessons unlock in order.');
    return res.redirect(`/learn/${ctx.course.slug}`);
  }
  const lesson = await one('SELECT * FROM lessons WHERE id = $1', [entry.id]);
  await query(
    `INSERT INTO lesson_progress (user_id, lesson_id, last_heartbeat_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id, lesson_id) DO UPDATE SET last_heartbeat_at = now()`,
    [req.user.id, lesson.id],
  );
  res.render('learn/lesson', {
    title: lesson.title,
    course: ctx.course,
    outline,
    lesson,
    entry,
    html: renderMarkdown(lesson.content_md),
    video: embedUrl(lesson.video_url),
    prev: outline.lessons[index - 1] ?? null,
    next: outline.lessons[index + 1] ?? null,
  });
});

async function lessonForUser(userId, lessonId) {
  if (!UUID.test(lessonId)) return null;
  return one(
    `SELECT l.id, l.min_seconds, c.slug, lp.seconds_spent, lp.last_heartbeat_at, lp.completed_at
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
  const outline = await courseOutline(
    (await one('SELECT id FROM courses WHERE slug = $1', [lesson.slug])).id,
    req.user.id,
  );
  const idx = outline.lessons.findIndex((l) => l.id === lesson.id);
  const entry = outline.lessons[idx];
  if (!entry.unlocked) return res.redirect(`/learn/${lesson.slug}`);
  if (!lesson.completed_at) {
    const spent = lesson.seconds_spent ?? 0;
    if (spent < lesson.min_seconds) {
      flash(req, 'warn', `Spend a little more time on this lesson (${Math.ceil((lesson.min_seconds - spent) / 60)} min left) before moving on.`);
      return res.redirect(`/learn/${lesson.slug}/lessons/${lesson.id}`);
    }
    await query('UPDATE lesson_progress SET completed_at = now() WHERE user_id = $1 AND lesson_id = $2', [req.user.id, lesson.id]);
  }
  const next = outline.lessons[idx + 1];
  res.redirect(next ? `/learn/${lesson.slug}/lessons/${next.id}` : `/learn/${lesson.slug}/exam`);
});

// ---------- Exam lobby ----------
router.get('/learn/:slug/exam', requireAuth, async (req, res) => {
  const ctx = await enrolledCourse(req, res);
  if (!ctx) return;
  const status = await examStatus(req.user, ctx.course);
  res.render('learn/exam-lobby', { title: `Final exam — ${ctx.course.title}`, course: ctx.course, status });
});

router.post('/learn/:slug/exam/start', requireAuth, async (req, res) => {
  const ctx = await enrolledCourse(req, res);
  if (!ctx) return;
  if (req.body.agree !== 'on') {
    flash(req, 'warn', 'Confirm that you agree to the exam rules to begin.');
    return res.redirect(`/learn/${ctx.course.slug}/exam`);
  }
  const result = await startAttempt(req.user, ctx.course, { ip: req.ip, userAgent: req.get('user-agent') });
  if (result.attemptId) return res.redirect(`/exam/${result.attemptId}`);
  if (result.error === 'in_progress') {
    const open = await one(`SELECT id FROM exam_attempts WHERE user_id = $1 AND course_id = $2 AND status = 'in_progress'`, [
      req.user.id,
      ctx.course.id,
    ]);
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
