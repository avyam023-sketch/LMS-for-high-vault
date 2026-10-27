import { Router } from 'express';
import { z } from 'zod';
import { many, one, query, tx } from '../db/pool.js';
import { requireStaff } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { parse, personName } from '../lib/validate.js';
import { flash } from '../lib/view-helpers.js';
import { parseCsv } from '../lib/csv.js';
import { decryptBuffer } from '../lib/crypto.js';
import { reviewAttempt } from '../lib/exam.js';
import { sendMail } from '../lib/mailer.js';
import { config } from '../config.js';
import { securityNotice } from '../lib/notify.js';

const router = Router();
router.use(requireStaff);

// Identity reviewers see only the review queue and the evidence it needs — nothing else.
const REVIEWER_ROUTES = [/^\/attempts(\/|$)/, /^\/media\//];
router.use((req, res, next) => {
  if (req.user.role === 'admin') return next();
  if (req.path === '/' && req.method === 'GET') return res.redirect('/admin/attempts?filter=review');
  if (REVIEWER_ROUTES.some((r) => r.test(req.path)) && !/\/(void|purge-evidence)$/.test(req.path)) return next();
  next(Object.assign(new Error('Not found'), { status: 404 }));
});
router.use((req, res, next) => {
  res.locals.adminNav = req.path.split('/')[1] || 'overview';
  res.set('Cache-Control', 'no-store');
  next();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.param('id', (req, res, next, id) => {
  if (!UUID.test(id) && !/^\d+$/.test(id)) {
    const err = new Error('Not found');
    err.status = 404;
    return next(err);
  }
  next();
});
const notFound = () => Object.assign(new Error('Not found'), { status: 404 });
const PAGE = 25;
const pageOf = (req) => Math.max(1, Number.parseInt(req.query.page, 10) || 1);
const lines = (s = '') => String(s).split('\n').map((l) => l.trim()).filter(Boolean);

// ---------- Overview ----------
router.get('/', async (req, res) => {
  const stats = await one(`SELECT
      (SELECT count(*)::int FROM users WHERE role = 'student') AS learners,
      (SELECT count(*)::int FROM users WHERE role = 'student' AND created_at > now() - interval '7 days') AS learners_7d,
      (SELECT count(*)::int FROM enrollments) AS enrollments,
      (SELECT count(*)::int FROM exam_attempts WHERE status = 'submitted' AND submitted_at > now() - interval '30 days') AS attempts_30d,
      (SELECT round(100.0 * avg(passed::int))::int FROM exam_attempts WHERE status = 'submitted' AND submitted_at > now() - interval '30 days') AS pass_rate_30d,
      (SELECT count(*)::int FROM certificates WHERE revoked_at IS NULL) AS certificates,
      (SELECT count(*)::int FROM exam_attempts WHERE (focus_violations > 0 OR auto_submitted = 'integrity') AND started_at > now() - interval '30 days') AS flagged_30d,
      (SELECT count(*)::int FROM exam_attempts WHERE status = 'in_progress') AS live_exams,
      (SELECT count(*)::int FROM exam_attempts WHERE review_status = 'pending') AS pending_reviews`);
  const recentAttempts = await many(
    `SELECT a.id, a.status, a.score_percent, a.passed, a.focus_violations, a.auto_submitted, a.started_at,
            u.first_name, u.last_name, u.email
       FROM exam_attempts a JOIN users u ON u.id = a.user_id ORDER BY a.started_at DESC LIMIT 8`,
  );
  const recentUsers = await many(
    `SELECT id, first_name, last_name, email, created_at, email_verified_at FROM users ORDER BY created_at DESC LIMIT 8`,
  );
  res.render('admin/overview', { title: 'Admin overview', stats, recentAttempts, recentUsers });
});

// ---------- Learners ----------
router.get('/users', async (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 100);
  const page = pageOf(req);
  const where = q ? `WHERE email ILIKE $1 OR (first_name || ' ' || last_name) ILIKE $1` : '';
  const params = q ? [`%${q.replace(/[%_\\]/g, '\\$&')}%`] : [];
  const users = await many(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.email_verified_at, u.disabled_at, u.created_at, u.last_login_at,
            (SELECT count(*) FROM certificates c WHERE c.user_id = u.id AND c.revoked_at IS NULL)::int AS certs
       FROM users u ${where} ORDER BY u.created_at DESC LIMIT ${PAGE + 1} OFFSET ${(page - 1) * PAGE}`,
    params,
  );
  res.render('admin/users', { title: 'Learners', users: users.slice(0, PAGE), hasMore: users.length > PAGE, page, q });
});

router.get('/users/:id', async (req, res) => {
  const member = await one('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!member) throw notFound();
  const enrollments = await many(
    `SELECT e.*, c.title, c.slug, c.max_attempts,
            (SELECT count(*) FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id JOIN modules m ON m.id = l.module_id
              WHERE lp.user_id = e.user_id AND m.course_id = e.course_id AND lp.completed_at IS NOT NULL)::int AS lessons_done,
            (SELECT count(*) FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = e.course_id)::int AS lessons_total
       FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.user_id = $1`,
    [member.id],
  );
  const attempts = await many(
    `SELECT a.*, c.title AS course_title FROM exam_attempts a JOIN courses c ON c.id = a.course_id WHERE a.user_id = $1 ORDER BY a.started_at DESC`,
    [member.id],
  );
  const certificates = await many('SELECT * FROM certificates WHERE user_id = $1 ORDER BY issued_at DESC', [member.id]);
  const courses = await many('SELECT id, title FROM courses ORDER BY created_at');
  const activity = await many(
    `SELECT action, ip, created_at FROM audit_log WHERE actor_id = $1 OR entity_id = $2 ORDER BY created_at DESC LIMIT 20`,
    [member.id, String(member.id)],
  );
  res.render('admin/user', { title: `${member.first_name} ${member.last_name}`, member, enrollments, attempts, certificates, courses, activity });
});

router.post('/users/:id/action', async (req, res) => {
  const member = await one('SELECT id, role FROM users WHERE id = $1', [req.params.id]);
  if (!member) throw notFound();
  const action = String(req.body.action);
  const self = member.id === req.user.id;
  const back = () => res.redirect(`/admin/users/${member.id}`);

  switch (action) {
    case 'disable':
      if (self) return flash(req, 'error', "You can't disable your own account."), back();
      await query('UPDATE users SET disabled_at = now(), active_session_id = NULL WHERE id = $1', [member.id]);
      await query(`DELETE FROM session WHERE sess->>'userId' = $1`, [member.id]);
      break;
    case 'enable':
      await query('UPDATE users SET disabled_at = NULL, failed_logins = 0, locked_until = NULL WHERE id = $1', [member.id]);
      break;
    case 'verify_email':
      await query('UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1', [member.id]);
      break;
    case 'sign_out':
      await query('UPDATE users SET active_session_id = NULL WHERE id = $1', [member.id]);
      await query(`DELETE FROM session WHERE sess->>'userId' = $1`, [member.id]);
      break;
    case 'make_admin':
    case 'make_reviewer':
    case 'make_student': {
      const role = { make_admin: 'admin', make_reviewer: 'reviewer', make_student: 'student' }[action];
      if (self) return flash(req, 'error', "You can't change your own role."), back();
      await query('UPDATE users SET role = $2, updated_at = now() WHERE id = $1', [member.id, role]);
      // A role change takes effect at the next sign-in, which also enforces two-step for staff.
      await query('UPDATE users SET active_session_id = NULL WHERE id = $1', [member.id]);
      await query(`DELETE FROM session WHERE sess->>'userId' = $1`, [member.id]);
      const target = await one('SELECT email, first_name FROM users WHERE id = $1', [member.id]);
      await sendMail({
        to: target.email,
        subject: 'Your account access changed — The High Vault Security',
        heading: `Hi ${target.first_name}`,
        body: [
          role === 'student' ? 'Your staff access has been removed.' : `You now have ${role === 'admin' ? 'administrator' : 'identity reviewer'} access.`,
          role === 'student' ? '' : 'Sign in again. You’ll be asked to set up two-step verification if you haven’t already.',
          `If you didn’t expect this change, contact ${config.SUPPORT_EMAIL} right away.`,
        ].filter(Boolean),
        action: { label: 'Sign in', url: `${config.appUrl}/login` },
      });
      break;
    }
    case 'reset_mfa': {
      await query('UPDATE users SET mfa_secret_enc = NULL, mfa_enabled_at = NULL WHERE id = $1', [member.id]);
      const target = await one('SELECT email FROM users WHERE id = $1', [member.id]);
      await securityNotice(target, 'Two-step verification was reset by an administrator');
      break;
    }
    case 'rename': {
      const { data, errors } = parse(z.object({ first_name: personName, last_name: personName }), req.body);
      if (errors) return flash(req, 'error', 'Enter a valid first and last name.'), back();
      await query('UPDATE users SET first_name = $2, last_name = $3, updated_at = now() WHERE id = $1', [member.id, data.first_name, data.last_name]);
      break;
    }
    case 'enroll': {
      if (!UUID.test(String(req.body.course_id))) return back();
      await query(`INSERT INTO enrollments (user_id, course_id, source) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`, [member.id, req.body.course_id]);
      break;
    }
    case 'extra_attempt': {
      if (!UUID.test(String(req.body.course_id))) return back();
      await query('UPDATE enrollments SET extra_attempts = extra_attempts + 1 WHERE user_id = $1 AND course_id = $2', [member.id, req.body.course_id]);
      break;
    }
    default:
      return back();
  }
  await audit(req, `admin.user.${action}`, { entity: 'user', entityId: member.id, meta: { course_id: req.body.course_id } });
  flash(req, 'success', 'Done.');
  back();
});

// ---------- Courses ----------
router.get('/courses', async (req, res) => {
  const courses = await many(`SELECT c.*,
      (SELECT count(*) FROM enrollments e WHERE e.course_id = c.id)::int AS enrolled,
      (SELECT count(*) FROM questions q WHERE q.course_id = c.id AND q.is_active AND q.pool = 'exam')::int AS questions,
      (SELECT count(*) FROM questions q WHERE q.course_id = c.id AND q.is_active AND q.pool = 'quiz')::int AS quiz_questions,
      (SELECT count(*) FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = c.id)::int AS lessons
    FROM courses c ORDER BY c.created_at`);
  res.render('admin/courses', { title: 'Courses', courses });
});

const int = (min, max) => z.coerce.number().int().min(min).max(max);
const courseSchema = z.object({
  title: z.string().trim().min(3).max(140),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Lowercase letters, numbers and dashes only.').max(80),
  subtitle: z.string().trim().max(300).default(''),
  description_md: z.string().max(50_000).default(''),
  highlights: z.string().max(5000).default(''),
  outcomes: z.string().max(5000).default(''),
  faqs: z.string().max(30_000).default(''),
  price: z.coerce.number().min(0).max(100_000),
  currency: z.enum(['cad', 'usd']).default('cad'),
  duration_minutes: int(1, 10_000),
  language: z.string().trim().min(2).max(40),
  pass_mark: int(1, 100),
  exam_question_count: int(1, 200),
  exam_time_limit_minutes: int(1, 600),
  max_attempts: int(1, 50),
  attempt_cooldown_minutes: int(0, 60 * 24 * 30),
  max_focus_violations: int(0, 50),
  certificate_validity_months: int(0, 240),
  is_published: z.literal('on').optional(),
  require_fullscreen: z.literal('on').optional(),
  proctoring_required: z.literal('on').optional(),
  identity_review_required: z.literal('on').optional(),
});

/** FAQ textarea format: question on the first line, answer below, blank line between items. */
const parseFaqs = (text) =>
  String(text)
    .split(/\n\s*\n/)
    .map((block) => block.trim().split('\n'))
    .filter((l) => l.length >= 2)
    .map(([q, ...a]) => ({ q: q.trim(), a: a.join(' ').trim() }));
const faqsToText = (faqs) => (faqs ?? []).map((f) => `${f.q}\n${f.a}`).join('\n\n');

function courseParams(d) {
  return [
    d.title, d.slug, d.subtitle, d.description_md, JSON.stringify(lines(d.highlights)), JSON.stringify(lines(d.outcomes)),
    JSON.stringify(parseFaqs(d.faqs)), Math.round(d.price * 100), d.currency, d.duration_minutes, d.language, Boolean(d.is_published),
    d.pass_mark, d.exam_question_count, d.exam_time_limit_minutes, d.max_attempts, d.attempt_cooldown_minutes,
    d.max_focus_violations, Boolean(d.require_fullscreen), d.certificate_validity_months,
    Boolean(d.proctoring_required), Boolean(d.identity_review_required),
  ];
}
const COURSE_COLS = `title, slug, subtitle, description_md, highlights, outcomes, faqs, price_cents, currency, duration_minutes, language,
  is_published, pass_mark, exam_question_count, exam_time_limit_minutes, max_attempts, attempt_cooldown_minutes,
  max_focus_violations, require_fullscreen, certificate_validity_months, proctoring_required, identity_review_required`;

function courseFormValues(c) {
  return { ...c, highlights: (c.highlights ?? []).join('\n'), outcomes: (c.outcomes ?? []).join('\n'), faqs: faqsToText(c.faqs), price: (c.price_cents ?? 0) / 100 };
}

router.get('/courses/new', (req, res) => {
  const defaults = {
    currency: 'cad', duration_minutes: 240, language: 'English', pass_mark: 70, exam_question_count: 40, exam_time_limit_minutes: 60,
    max_attempts: 3, attempt_cooldown_minutes: 60, max_focus_violations: 3, certificate_validity_months: 60, require_fullscreen: true, price_cents: 0,
    proctoring_required: true, identity_review_required: true,
  };
  res.render('admin/course-form', { title: 'New course', course: null, values: courseFormValues(defaults), errors: {} });
});

router.post('/courses', async (req, res) => {
  const { data, errors } = parse(courseSchema, req.body);
  if (errors) return res.status(422).render('admin/course-form', { title: 'New course', course: null, values: req.body, errors });
  try {
    const params = courseParams(data);
    const course = await one(
      `INSERT INTO courses (${COURSE_COLS}) VALUES (${params.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      params,
    );
    await audit(req, 'admin.course.create', { entity: 'course', entityId: course.id });
    flash(req, 'success', 'Course created. Add modules and lessons next.');
    res.redirect(`/admin/courses/${course.id}`);
  } catch (err) {
    if (err.code !== '23505') throw err;
    res.status(422).render('admin/course-form', { title: 'New course', course: null, values: req.body, errors: { slug: 'That URL slug is taken.' } });
  }
});

router.get('/courses/:id', async (req, res) => {
  const course = await one('SELECT * FROM courses WHERE id = $1', [req.params.id]);
  if (!course) throw notFound();
  const modules = await many('SELECT * FROM modules WHERE course_id = $1 ORDER BY position, title', [course.id]);
  const lessons = await many(
    `SELECT l.id, l.module_id, l.title, l.position, l.min_seconds, l.video_url IS NOT NULL AS has_video
       FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = $1 ORDER BY l.position, l.title`,
    [course.id],
  );
  for (const m of modules) m.lessons = lessons.filter((l) => l.module_id === m.id);
  res.render('admin/course-form', { title: course.title, course, modules, values: courseFormValues(course), errors: {} });
});

router.post('/courses/:id', async (req, res) => {
  const course = await one('SELECT * FROM courses WHERE id = $1', [req.params.id]);
  if (!course) throw notFound();
  const { data, errors } = parse(courseSchema, req.body);
  const rerender = async (errs) => {
    const modules = await many('SELECT * FROM modules WHERE course_id = $1 ORDER BY position', [course.id]);
    modules.forEach((m) => (m.lessons = []));
    res.status(422).render('admin/course-form', { title: course.title, course, modules, values: req.body, errors: errs });
  };
  if (errors) return rerender(errors);
  try {
    const params = courseParams(data);
    const sets = COURSE_COLS.split(',').map((c, i) => `${c.trim()} = $${i + 2}`).join(', ');
    await query(`UPDATE courses SET ${sets}, updated_at = now() WHERE id = $1`, [course.id, ...params]);
  } catch (err) {
    if (err.code !== '23505') throw err;
    return rerender({ slug: 'That URL slug is taken.' });
  }
  await audit(req, 'admin.course.update', { entity: 'course', entityId: course.id });
  flash(req, 'success', 'Course saved.');
  res.redirect(`/admin/courses/${course.id}`);
});

// ---------- Modules ----------
const moduleSchema = z.object({ title: z.string().trim().min(1).max(140), position: z.coerce.number().int().min(0).max(1000).default(0) });

router.post('/courses/:id/modules', async (req, res) => {
  const { data, errors } = parse(moduleSchema, req.body);
  if (errors) return flash(req, 'error', 'Module title is required.'), res.redirect(`/admin/courses/${req.params.id}`);
  const m = await one('INSERT INTO modules (course_id, title, position) VALUES ($1, $2, $3) RETURNING id', [req.params.id, data.title, data.position]);
  await audit(req, 'admin.module.create', { entity: 'module', entityId: m.id });
  res.redirect(`/admin/courses/${req.params.id}#modules`);
});

router.post('/modules/:id', async (req, res) => {
  const mod = await one('SELECT * FROM modules WHERE id = $1', [req.params.id]);
  if (!mod) throw notFound();
  if (req.body.action === 'delete') {
    await query('DELETE FROM modules WHERE id = $1', [mod.id]);
    await audit(req, 'admin.module.delete', { entity: 'module', entityId: mod.id, meta: { title: mod.title } });
    flash(req, 'success', 'Module deleted.');
  } else {
    const { data, errors } = parse(moduleSchema, req.body);
    if (!errors) await query('UPDATE modules SET title = $2, position = $3 WHERE id = $1', [mod.id, data.title, data.position]);
    await audit(req, 'admin.module.update', { entity: 'module', entityId: mod.id });
  }
  res.redirect(`/admin/courses/${mod.course_id}#modules`);
});

// ---------- Lessons ----------
const lessonSchema = z.object({
  title: z.string().trim().min(1).max(160),
  content_md: z.string().max(100_000).default(''),
  video_url: z.union([z.literal(''), z.url().max(500).refine((u) => u.startsWith('https://'), 'Use an https:// link.')]).default(''),
  min_seconds: z.coerce.number().int().min(0).max(36_000),
  position: z.coerce.number().int().min(0).max(1000).default(0),
  module_id: z.uuid(),
});

async function lessonForm(res, { lesson, moduleId, values, errors = {} }) {
  const mod = await one('SELECT m.*, c.title AS course_title FROM modules m JOIN courses c ON c.id = m.course_id WHERE m.id = $1', [moduleId]);
  if (!mod) throw notFound();
  const modules = await many('SELECT id, title FROM modules WHERE course_id = $1 ORDER BY position', [mod.course_id]);
  res.render('admin/lesson-form', { title: lesson ? lesson.title : 'New lesson', lesson, mod, modules, values, errors });
}

router.get('/lessons/new', async (req, res) => {
  if (!UUID.test(String(req.query.module))) throw notFound();
  await lessonForm(res, { lesson: null, moduleId: req.query.module, values: { min_seconds: 120, module_id: req.query.module } });
});

router.post('/lessons', async (req, res) => {
  const { data, errors } = parse(lessonSchema, req.body);
  if (errors) return lessonForm(res.status(422), { lesson: null, moduleId: req.body.module_id, values: req.body, errors });
  const l = await one(
    'INSERT INTO lessons (module_id, title, content_md, video_url, min_seconds, position) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [data.module_id, data.title, data.content_md, data.video_url || null, data.min_seconds, data.position],
  );
  await audit(req, 'admin.lesson.create', { entity: 'lesson', entityId: l.id });
  const mod = await one('SELECT course_id FROM modules WHERE id = $1', [data.module_id]);
  flash(req, 'success', 'Lesson created.');
  res.redirect(`/admin/courses/${mod.course_id}#modules`);
});

router.get('/lessons/:id', async (req, res) => {
  const lesson = await one('SELECT * FROM lessons WHERE id = $1', [req.params.id]);
  if (!lesson) throw notFound();
  await lessonForm(res, { lesson, moduleId: lesson.module_id, values: { ...lesson, video_url: lesson.video_url ?? '' } });
});

router.post('/lessons/:id', async (req, res) => {
  const lesson = await one('SELECT l.*, m.course_id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.id = $1', [req.params.id]);
  if (!lesson) throw notFound();
  if (req.body.action === 'delete') {
    await query('DELETE FROM lessons WHERE id = $1', [lesson.id]);
    await audit(req, 'admin.lesson.delete', { entity: 'lesson', entityId: lesson.id, meta: { title: lesson.title } });
    flash(req, 'success', 'Lesson deleted.');
    return res.redirect(`/admin/courses/${lesson.course_id}#modules`);
  }
  const { data, errors } = parse(lessonSchema, req.body);
  if (errors) return lessonForm(res.status(422), { lesson, moduleId: lesson.module_id, values: req.body, errors });
  await query(
    'UPDATE lessons SET module_id = $2, title = $3, content_md = $4, video_url = $5, min_seconds = $6, position = $7 WHERE id = $1',
    [lesson.id, data.module_id, data.title, data.content_md, data.video_url || null, data.min_seconds, data.position],
  );
  await audit(req, 'admin.lesson.update', { entity: 'lesson', entityId: lesson.id });
  flash(req, 'success', 'Lesson saved.');
  res.redirect(`/admin/lessons/${lesson.id}`);
});

// ---------- Question bank ----------
router.get('/courses/:id/questions', async (req, res) => {
  const course = await one('SELECT id, title, exam_question_count FROM courses WHERE id = $1', [req.params.id]);
  if (!course) throw notFound();
  const poolFilter = req.query.pool === 'quiz' ? 'quiz' : 'exam';
  const counts = await one(
    `SELECT count(*) FILTER (WHERE pool = 'exam' AND is_active)::int AS exam, count(*) FILTER (WHERE pool = 'quiz' AND is_active)::int AS quiz
       FROM questions WHERE course_id = $1`,
    [course.id],
  );
  const questions = await many(
    `SELECT q.id, q.prompt, q.kind, q.is_active, q.pool, m.title AS module_title, m.position AS module_position,
            (SELECT count(*) FROM question_options o WHERE o.question_id = q.id)::int AS options,
            (SELECT count(*) FROM attempt_answers aa JOIN exam_attempts a ON a.id = aa.attempt_id WHERE aa.question_id = q.id AND a.status = 'submitted')::int AS answered
       FROM questions q LEFT JOIN modules m ON m.id = q.module_id WHERE q.course_id = $1 AND q.pool = $2
      ORDER BY m.position NULLS LAST, q.position, q.created_at`,
    [course.id, poolFilter],
  );
  res.render('admin/questions', { title: `Question bank — ${course.title}`, course, questions, poolFilter, counts });
});

const questionSchema = z.object({
  pool: z.enum(['exam', 'quiz']).default('exam'),
  position: z.coerce.number().int().min(0).max(1000).default(0),
  prompt: z.string().trim().min(5).max(2000),
  kind: z.enum(['single', 'multi']),
  module_id: z.union([z.literal(''), z.uuid()]).default(''),
  explanation: z.string().trim().max(2000).default(''),
  is_active: z.literal('on').optional(),
});

function readOptions(body) {
  const options = [];
  for (let i = 0; i < 8; i++) {
    const text = String(body[`opt_body_${i}`] ?? '').trim().slice(0, 500);
    if (!text) continue;
    const id = String(body[`opt_id_${i}`] ?? '');
    options.push({ id: UUID.test(id) ? id : null, body: text, is_correct: body[`opt_correct_${i}`] === 'on' });
  }
  return options;
}

function questionErrors(data, options) {
  if (data.pool === 'quiz' && !data.module_id) return 'Choose the module this quiz question belongs to.';
  if (options.length < 2) return 'Add at least two answer options.';
  const correct = options.filter((o) => o.is_correct).length;
  if (correct === 0) return 'Mark at least one option as correct.';
  if (data.kind === 'single' && correct > 1) return 'A single-answer question can only have one correct option.';
  return null;
}

async function questionForm(res, { course, question, values, options, error }) {
  const modules = await many('SELECT id, title FROM modules WHERE course_id = $1 ORDER BY position', [course.id]);
  while (options.length < 4) options.push({ id: null, body: '', is_correct: false });
  res.render('admin/question-form', { title: question ? 'Edit question' : 'New question', course, question, values, options, modules, error });
}

router.get('/courses/:id/questions/new', async (req, res) => {
  const course = await one('SELECT id, title FROM courses WHERE id = $1', [req.params.id]);
  if (!course) throw notFound();
  const pool = req.query.pool === 'quiz' ? 'quiz' : 'exam';
  await questionForm(res, { course, question: null, values: { kind: 'single', is_active: true, pool }, options: [], error: null });
});

router.post('/courses/:id/questions', async (req, res) => {
  const course = await one('SELECT id, title FROM courses WHERE id = $1', [req.params.id]);
  if (!course) throw notFound();
  const { data, errors } = parse(questionSchema, req.body);
  const options = readOptions(req.body);
  const error = errors ? Object.values(errors)[0] : questionErrors(data, options);
  if (error) return questionForm(res.status(422), { course, question: null, values: req.body, options, error });
  const q = await tx(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO questions (course_id, module_id, prompt, kind, explanation, is_active, pool, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [course.id, data.module_id || null, data.prompt, data.kind, data.explanation, Boolean(data.is_active), data.pool, data.position],
    );
    for (const [i, o] of options.entries()) {
      await db.query('INSERT INTO question_options (question_id, body, is_correct, position) VALUES ($1, $2, $3, $4)', [rows[0].id, o.body, o.is_correct, i]);
    }
    return rows[0];
  });
  await audit(req, 'admin.question.create', { entity: 'question', entityId: q.id });
  flash(req, 'success', 'Question added.');
  res.redirect(req.body.another === '1' ? `/admin/courses/${course.id}/questions/new?pool=${data.pool}` : `/admin/courses/${course.id}/questions?pool=${data.pool}`);
});

router.get('/questions/:id', async (req, res) => {
  const question = await one('SELECT * FROM questions WHERE id = $1', [req.params.id]);
  if (!question) throw notFound();
  const course = await one('SELECT id, title FROM courses WHERE id = $1', [question.course_id]);
  const options = await many('SELECT id, body, is_correct FROM question_options WHERE question_id = $1 ORDER BY position', [question.id]);
  await questionForm(res, { course, question, values: { ...question, module_id: question.module_id ?? '' }, options, error: null });
});

router.post('/questions/:id', async (req, res) => {
  const question = await one('SELECT * FROM questions WHERE id = $1', [req.params.id]);
  if (!question) throw notFound();
  const course = await one('SELECT id, title FROM courses WHERE id = $1', [question.course_id]);
  if (req.body.action === 'delete') {
    await query('DELETE FROM questions WHERE id = $1', [question.id]);
    await audit(req, 'admin.question.delete', { entity: 'question', entityId: question.id });
    flash(req, 'success', 'Question deleted.');
    return res.redirect(`/admin/courses/${course.id}/questions?pool=${question.pool}`);
  }
  const { data, errors } = parse(questionSchema, req.body);
  const options = readOptions(req.body);
  const error = errors ? Object.values(errors)[0] : questionErrors(data, options);
  if (error) return questionForm(res.status(422), { course, question, values: req.body, options, error });
  await tx(async (db) => {
    await db.query(
      'UPDATE questions SET module_id = $2, prompt = $3, kind = $4, explanation = $5, is_active = $6, pool = $7, position = $8 WHERE id = $1',
      [question.id, data.module_id || null, data.prompt, data.kind, data.explanation, Boolean(data.is_active), data.pool, data.position],
    );
    // Update options in place so exams already in progress keep valid option ids.
    const keep = options.filter((o) => o.id).map((o) => o.id);
    await db.query('DELETE FROM question_options WHERE question_id = $1 AND NOT (id = ANY($2::uuid[]))', [question.id, keep]);
    for (const [i, o] of options.entries()) {
      if (o.id) {
        await db.query('UPDATE question_options SET body = $3, is_correct = $4, position = $5 WHERE id = $1 AND question_id = $2', [o.id, question.id, o.body, o.is_correct, i]);
      } else {
        await db.query('INSERT INTO question_options (question_id, body, is_correct, position) VALUES ($1, $2, $3, $4)', [question.id, o.body, o.is_correct, i]);
      }
    }
  });
  await audit(req, 'admin.question.update', { entity: 'question', entityId: question.id });
  flash(req, 'success', 'Question saved.');
  res.redirect(`/admin/courses/${course.id}/questions?pool=${data.pool}`);
});

/**
 * CSV import. Columns: prompt, option_a, option_b, option_c, option_d, correct, module, explanation.
 * `correct` holds letters, e.g. "B" or "A;C" (several letters make it a multi-answer question).
 */
router.post('/courses/:id/questions/import', async (req, res) => {
  const course = await one('SELECT id FROM courses WHERE id = $1', [req.params.id]);
  if (!course) throw notFound();
  const pool = req.body.pool === 'quiz' ? 'quiz' : 'exam';
  const rows = parseCsv(String(req.body.csv ?? '').slice(0, 150_000));
  const modules = await many('SELECT id, lower(title) AS title FROM modules WHERE course_id = $1', [course.id]);
  const header = rows[0]?.map((h) => h.trim().toLowerCase());
  const body = header?.[0] === 'prompt' ? rows.slice(1) : rows;
  const problems = [];
  const ready = [];
  body.forEach((r, idx) => {
    const [prompt, a, b, c, d, correct, moduleTitle, explanation] = r.map((v) => (v ?? '').trim());
    const opts = [a, b, c, d].map((t, i) => ({ body: t, letter: 'ABCD'[i] })).filter((o) => o.body);
    const letters = (correct ?? '').toUpperCase().split(/[;,\s]+/).filter(Boolean);
    const moduleId = modules.find((m) => m.title === (moduleTitle ?? '').toLowerCase())?.id ?? null;
    if (!prompt || opts.length < 2 || !letters.length || !letters.every((l) => opts.some((o) => o.letter === l)) || (pool === 'quiz' && !moduleId)) {
      problems.push(idx + (header?.[0] === 'prompt' ? 2 : 1));
      return;
    }
    ready.push({
      prompt: prompt.slice(0, 2000),
      kind: letters.length > 1 ? 'multi' : 'single',
      moduleId,
      explanation: (explanation ?? '').slice(0, 2000),
      options: opts.map((o) => ({ body: o.body.slice(0, 500), is_correct: letters.includes(o.letter) })),
    });
  });
  await tx(async (db) => {
    for (const q of ready) {
      const { rows: ins } = await db.query(
        'INSERT INTO questions (course_id, module_id, prompt, kind, explanation, pool, position) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
        [course.id, q.moduleId, q.prompt, q.kind, q.explanation, pool, 100],
      );
      for (const [i, o] of q.options.entries()) {
        await db.query('INSERT INTO question_options (question_id, body, is_correct, position) VALUES ($1, $2, $3, $4)', [ins[0].id, o.body, o.is_correct, i]);
      }
    }
  });
  await audit(req, 'admin.question.import', { entity: 'course', entityId: course.id, meta: { imported: ready.length, skipped: problems.length } });
  flash(
    req,
    problems.length ? 'warn' : 'success',
    `Imported ${ready.length} question${ready.length === 1 ? '' : 's'}.` + (problems.length ? ` Skipped rows: ${problems.slice(0, 15).join(', ')}.` : ''),
  );
  res.redirect(`/admin/courses/${course.id}/questions?pool=${pool}`);
});

// ---------- Exam attempts ----------
router.get('/attempts', async (req, res) => {
  const filter = ['review', 'flagged', 'passed', 'failed', 'live', 'voided'].includes(req.query.filter) ? req.query.filter : 'all';
  const page = pageOf(req);
  const where = {
    all: `a.status <> 'checkin'`,
    review: `a.review_status = 'pending'`,
    flagged: `(a.focus_violations > 0 OR a.auto_submitted = 'integrity'
               OR EXISTS (SELECT 1 FROM integrity_events e WHERE e.attempt_id = a.id AND e.kind IN ('no_face', 'multiple_faces', 'noise', 'face_check_skipped')))`,
    passed: `a.status = 'submitted' AND a.passed`,
    failed: `a.status = 'submitted' AND NOT a.passed`,
    live: `a.status = 'in_progress'`,
    voided: `a.status = 'voided'`,
  }[filter];
  const attempts = await many(
    `SELECT a.id, a.status, a.score_percent, a.passed, a.focus_violations, a.auto_submitted, a.started_at, a.submitted_at, a.ip, a.review_status,
            u.id AS user_id, u.first_name, u.last_name, u.email, c.title AS course_title,
            (SELECT count(*) FROM integrity_events e WHERE e.attempt_id = a.id)::int AS events
       FROM exam_attempts a JOIN users u ON u.id = a.user_id JOIN courses c ON c.id = a.course_id
      WHERE ${where} ORDER BY ${filter === 'review' ? 'a.submitted_at ASC' : 'a.started_at DESC'} LIMIT ${PAGE + 1} OFFSET ${(page - 1) * PAGE}`,
  );
  res.render('admin/attempts', { title: 'Exam attempts', attempts: attempts.slice(0, PAGE), hasMore: attempts.length > PAGE, page, filter });
});

router.get('/attempts/:id', async (req, res) => {
  const attempt = await one(
    `SELECT a.*, u.first_name, u.last_name, u.email, c.title AS course_title, c.pass_mark, c.max_focus_violations
       FROM exam_attempts a JOIN users u ON u.id = a.user_id JOIN courses c ON c.id = a.course_id WHERE a.id = $1`,
    [req.params.id],
  );
  if (!attempt) throw notFound();
  const questions = await many('SELECT id, prompt, kind FROM questions WHERE id = ANY($1)', [attempt.question_ids]);
  const options = await many('SELECT id, question_id, body, is_correct FROM question_options WHERE question_id = ANY($1) ORDER BY position', [attempt.question_ids]);
  const answers = await many('SELECT question_id, option_ids, answered_at FROM attempt_answers WHERE attempt_id = $1', [attempt.id]);
  const answerMap = new Map(answers.map((a) => [a.question_id, a]));
  const qMap = new Map(questions.map((q) => [q.id, q]));
  const paper = attempt.question_ids.filter((id) => qMap.has(id)).map((id) => {
    const opts = options.filter((o) => o.question_id === id);
    const ans = answerMap.get(id);
    const chosen = new Set(ans?.option_ids ?? []);
    const correct = opts.filter((o) => o.is_correct);
    const isRight = ans && chosen.size === correct.length && correct.every((o) => chosen.has(o.id));
    return { ...qMap.get(id), options: opts.map((o) => ({ ...o, chosen: chosen.has(o.id) })), answeredAt: ans?.answered_at, isRight: Boolean(isRight) };
  });
  const events = await many('SELECT * FROM integrity_events WHERE attempt_id = $1 ORDER BY occurred_at', [attempt.id]);
  const certificate = await one('SELECT * FROM certificates WHERE attempt_id = $1', [attempt.id]);
  const media = await many(
    'SELECT id, kind, mime, byte_size, note, created_at FROM proctor_media WHERE attempt_id = $1 ORDER BY created_at',
    [attempt.id],
  );
  const reviewer = attempt.reviewed_by ? await one('SELECT email FROM users WHERE id = $1', [attempt.reviewed_by]) : null;
  res.render('admin/attempt', {
    title: 'Exam attempt', attempt, paper, events, certificate, reviewer,
    face: media.find((m) => m.kind === 'face'),
    idPhoto: media.find((m) => m.kind === 'id'),
    roomScan: media.find((m) => m.kind === 'room_scan'),
    snapshots: media.filter((m) => m.kind === 'snapshot'),
    retentionDays: config.PROCTOR_RETENTION_DAYS,
    decisionDays: config.PROCTOR_RETENTION_AFTER_DECISION_DAYS,
  });
});

router.post('/attempts/:id/void', async (req, res) => {
  const reason = String(req.body.reason ?? '').trim().slice(0, 300);
  if (!reason) return flash(req, 'error', 'Give a reason for voiding.'), res.redirect(`/admin/attempts/${req.params.id}`);
  await tx(async (db) => {
    await db.query(
      `UPDATE exam_attempts SET status = 'voided', void_reason = $2, submitted_at = coalesce(submitted_at, now()),
              review_status = CASE WHEN review_status = 'pending' THEN 'rejected' ELSE review_status END
        WHERE id = $1`,
      [req.params.id, reason],
    );
    await db.query(`UPDATE certificates SET revoked_at = now(), revoke_reason = $2 WHERE attempt_id = $1 AND revoked_at IS NULL`, [req.params.id, `Exam voided: ${reason}`]);
  });
  await audit(req, 'admin.attempt.void', { entity: 'attempt', entityId: req.params.id, meta: { reason } });
  flash(req, 'success', 'Attempt voided. Any certificate from it is revoked.');
  res.redirect(`/admin/attempts/${req.params.id}`);
});

/** Identity review decision on a passed, proctored attempt. */
router.post('/attempts/:id/review', async (req, res) => {
  const decision = req.body.decision === 'approve' ? 'approve' : req.body.decision === 'reject' ? 'reject' : null;
  const note = String(req.body.note ?? '').trim().slice(0, 300);
  if (!decision) return res.redirect(`/admin/attempts/${req.params.id}`);
  if (decision === 'reject' && !note) return flash(req, 'error', 'Give a reason for rejecting — the learner will see it.'), res.redirect(`/admin/attempts/${req.params.id}`);
  const result = await reviewAttempt(req.params.id, req.user.id, decision, note);
  if (result.error) {
    flash(req, 'warn', 'This attempt is no longer waiting for review.');
    return res.redirect(`/admin/attempts/${req.params.id}`);
  }
  const learner = await one('SELECT email, first_name FROM users WHERE id = $1', [result.attempt.user_id]);
  if (decision === 'approve') {
    await sendMail({
      to: learner.email,
      subject: 'Your certificate is ready — The High Vault Security',
      heading: `Congratulations, ${learner.first_name}`,
      body: [`Your exam review is complete and your certificate (${result.certificate.code}) has been issued.`, 'You can download it from your dashboard at any time.'],
      action: { label: 'Download your certificate', url: `${config.appUrl}/dashboard` },
    });
  } else {
    await sendMail({
      to: learner.email,
      subject: 'About your exam — The High Vault Security',
      heading: 'We couldn’t verify your exam',
      body: [`Reason: ${note}`, `If you think this is a mistake, reply to ${config.SUPPORT_EMAIL}.`],
    });
  }
  await audit(req, `admin.attempt.${decision}`, { entity: 'attempt', entityId: req.params.id, meta: { note } });
  flash(req, 'success', decision === 'approve' ? `Approved. Certificate ${result.certificate.code} issued and the learner was emailed.` : 'Rejected. The learner was emailed.');
  // Move straight on to the next attempt waiting for review.
  const next = await one(`SELECT id FROM exam_attempts WHERE review_status = 'pending' ORDER BY submitted_at LIMIT 1`);
  res.redirect(next ? `/admin/attempts/${next.id}` : '/admin/attempts?filter=review');
});

/** Deletes an attempt's ID photo, face photo, room scan and snapshots now (after a decision). */
router.post('/attempts/:id/purge-evidence', async (req, res) => {
  const attempt = await one('SELECT id, status, review_status FROM exam_attempts WHERE id = $1', [req.params.id]);
  if (!attempt) throw notFound();
  if (attempt.review_status === 'pending' || ['checkin', 'in_progress'].includes(attempt.status)) {
    flash(req, 'error', 'Decide on the attempt before deleting its evidence.');
    return res.redirect(`/admin/attempts/${attempt.id}`);
  }
  const { rowCount } = await query('DELETE FROM proctor_media WHERE attempt_id = $1', [attempt.id]);
  await query('UPDATE exam_attempts SET evidence_purged_at = now() WHERE id = $1', [attempt.id]);
  await audit(req, 'admin.attempt.evidence_purged', { entity: 'attempt', entityId: attempt.id, meta: { files: rowCount } });
  flash(req, 'success', `Deleted ${rowCount} file${rowCount === 1 ? '' : 's'}.`);
  res.redirect(`/admin/attempts/${attempt.id}`);
});

/** Streams a decrypted proctoring file. Admin-only, never cached; supports seeking in videos. */
router.get('/media/:id', async (req, res) => {
  const row = await one('SELECT id, attempt_id, kind, mime, data FROM proctor_media WHERE id = $1', [req.params.id]);
  if (!row) throw notFound();
  const buf = decryptBuffer(row.data, { purpose: 'proctor-media', context: `${row.attempt_id}:${row.kind}` });
  // Every look at ID evidence is recorded: once per reviewer, attempt and file type per 10 minutes.
  const seen = await one(
    `SELECT 1 FROM audit_log WHERE actor_id = $1 AND action = 'staff.evidence_viewed' AND entity_id = $2
       AND meta->>'kind' = $3 AND created_at > now() - interval '10 minutes'`,
    [req.user.id, row.attempt_id, row.kind],
  );
  if (!seen) await audit(req, 'staff.evidence_viewed', { entity: 'attempt', entityId: row.attempt_id, meta: { kind: row.kind } });
  res.set({ 'Cache-Control': 'no-store', 'Content-Type': row.mime, 'Accept-Ranges': 'bytes', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' });
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.get('range') ?? '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : buf.length - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : buf.length - 1;
    start = Math.max(0, start);
    end = Math.min(end, buf.length - 1);
    if (start > end) return res.status(416).set('Content-Range', `bytes */${buf.length}`).end();
    res.status(206).set('Content-Range', `bytes ${start}-${end}/${buf.length}`);
    return res.send(buf.subarray(start, end + 1));
  }
  res.send(buf);
});

// ---------- Certificates ----------
router.get('/certificates', async (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 100);
  const page = pageOf(req);
  const params = q ? [`%${q.replace(/[%_\\]/g, '\\$&')}%`] : [];
  const certificates = await many(
    `SELECT c.*, u.email FROM certificates c JOIN users u ON u.id = c.user_id
      ${q ? 'WHERE c.code ILIKE $1 OR c.full_name ILIKE $1 OR u.email ILIKE $1' : ''}
      ORDER BY c.issued_at DESC LIMIT ${PAGE + 1} OFFSET ${(page - 1) * PAGE}`,
    params,
  );
  res.render('admin/certificates', { title: 'Certificates', certificates: certificates.slice(0, PAGE), hasMore: certificates.length > PAGE, page, q });
});

router.get('/certificates.csv', async (req, res) => {
  const rows = await many(
    `SELECT c.code, c.full_name, u.email, c.course_title, c.score_percent, c.issued_at, c.expires_at, c.revoked_at, c.revoke_reason
       FROM certificates c JOIN users u ON u.id = c.user_id ORDER BY c.issued_at DESC`,
  );
  // Prefix risky leading characters so spreadsheet apps don't execute them as formulas.
  const cell = (v) => {
    let s = v instanceof Date ? v.toISOString() : String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const header = ['code', 'name', 'email', 'course', 'score', 'issued_at', 'expires_at', 'revoked_at', 'revoke_reason'];
  const csv = [header.join(','), ...rows.map((r) => Object.values(r).map(cell).join(','))].join('\r\n');
  await audit(req, 'admin.certificates.export', { meta: { rows: rows.length } });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="certificates.csv"' });
  res.send(csv);
});

router.post('/certificates/:id', async (req, res) => {
  if (req.body.action === 'revoke') {
    const reason = String(req.body.reason ?? '').trim().slice(0, 300) || 'Revoked by administrator';
    await query('UPDATE certificates SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL', [req.params.id, reason]);
    await audit(req, 'admin.certificate.revoke', { entity: 'certificate', entityId: req.params.id, meta: { reason } });
    flash(req, 'success', 'Certificate revoked.');
  } else if (req.body.action === 'reinstate') {
    await query('UPDATE certificates SET revoked_at = NULL, revoke_reason = NULL WHERE id = $1', [req.params.id]);
    await audit(req, 'admin.certificate.reinstate', { entity: 'certificate', entityId: req.params.id });
    flash(req, 'success', 'Certificate reinstated.');
  }
  const back = req.get('referer');
  res.redirect(back && new URL(back, 'http://x').pathname.startsWith('/admin/') ? new URL(back, 'http://x').pathname : '/admin/certificates');
});

// ---------- Audit log ----------
router.get('/audit', async (req, res) => {
  const page = pageOf(req);
  const entries = await many(
    `SELECT l.*, u.email AS actor_email FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id
      ORDER BY l.created_at DESC LIMIT ${PAGE * 2 + 1} OFFSET ${(page - 1) * PAGE * 2}`,
  );
  res.render('admin/audit', { title: 'Audit log', entries: entries.slice(0, PAGE * 2), hasMore: entries.length > PAGE * 2, page });
});

export default router;
