import { Router } from 'express';
import { many, one } from '../db/pool.js';
import { renderMarkdown } from '../lib/markdown.js';
import { courseOutline } from '../lib/exam.js';
import { verifyLimiter } from '../lib/limits.js';
import { config } from '../config.js';

const router = Router();

async function coursePage(req, res, course) {
  if (!course) return res.status(404).render('error', { title: 'Page not found', status: 404, message: 'This course is not available.' });
  const outline = await courseOutline(course.id, req.user?.id);
  const enrollment = req.user
    ? await one('SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2', [req.user.id, course.id])
    : null;
  const questionCount = (await one(`SELECT count(*)::int AS n FROM questions WHERE course_id = $1 AND pool = 'exam' AND is_active`, [course.id])).n;
  res.render('public/course', {
    title: course.title,
    description: course.subtitle,
    course,
    descriptionHtml: renderMarkdown(course.description_md),
    outline,
    enrollment,
    examQuestions: Math.min(questionCount, course.exam_question_count),
  });
}

// The academy sells one flagship course: the home page is its product page.
router.get('/', async (req, res) => {
  const course = await one('SELECT * FROM courses WHERE is_published ORDER BY created_at LIMIT 1');
  await coursePage(req, res, course);
});

router.get('/course/:slug', async (req, res) => {
  const course = await one('SELECT * FROM courses WHERE slug = $1 AND (is_published OR $2)', [
    req.params.slug,
    req.user?.role === 'admin',
  ]);
  await coursePage(req, res, course);
});

router.get('/courses', async (req, res) => {
  const courses = await many('SELECT * FROM courses WHERE is_published ORDER BY created_at');
  if (courses.length === 1) return res.redirect('/');
  res.render('public/courses', { title: 'Courses', courses });
});

router.get('/verify', async (req, res) => {
  const code = String(req.query.code ?? '').trim().toUpperCase();
  if (code) return res.redirect(`/verify/${encodeURIComponent(code)}`);
  res.render('public/verify', { title: 'Verify a certificate', cert: null, code: '' });
});

router.get('/verify/:code', verifyLimiter, async (req, res) => {
  const code = req.params.code.trim().toUpperCase().slice(0, 32);
  const cert = /^HV-\d{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)
    ? await one('SELECT code, full_name, course_title, issued_at, expires_at, revoked_at FROM certificates WHERE code = $1', [code])
    : null;
  let status = 'not_found';
  if (cert) status = cert.revoked_at ? 'revoked' : cert.expires_at && new Date(cert.expires_at) < new Date() ? 'expired' : 'valid';
  res.set('X-Robots-Tag', 'noindex');
  res.render('public/verify', { title: 'Verify a certificate', cert, code, status });
});

router.get('/privacy', (req, res) => res.render('public/privacy', { title: 'Privacy', retentionDays: config.PROCTOR_RETENTION_DAYS }));

export default router;
