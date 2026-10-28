import { Router } from 'express';
import { many, one } from '../db/pool.js';
import { renderMarkdown } from '../lib/markdown.js';
import { courseOutline } from '../lib/exam.js';
import { verifyLimiter } from '../lib/limits.js';
import { config } from '../config.js';
import { POLICIES, POLICIES_UPDATED } from '../lib/policies.js';

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
    deletedNotice: req.query.deleted === '1',
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


router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    ['User-agent: *', 'Allow: /', 'Disallow: /admin', 'Disallow: /account', 'Disallow: /dashboard', 'Disallow: /learn', 'Disallow: /exam',
      'Disallow: /certificates', 'Disallow: /verify/', '', `Sitemap: ${config.appUrl}/sitemap.xml`, ''].join('\n'),
  );
});

router.get('/sitemap.xml', async (req, res) => {
  const courses = await many('SELECT slug, updated_at FROM courses WHERE is_published ORDER BY created_at');
  const urls = [
    { loc: '/', lastmod: courses[0]?.updated_at },
    ...courses.slice(1).map((c) => ({ loc: `/course/${c.slug}`, lastmod: c.updated_at })),
    { loc: '/about' }, { loc: '/verify' }, { loc: '/register' }, { loc: '/policies' }, ...POLICIES.map((p) => ({ loc: p.path })),
  ];
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((u) => `  <url><loc>${config.appUrl}${u.loc}</loc>${u.lastmod ? `<lastmod>${new Date(u.lastmod).toISOString().slice(0, 10)}</lastmod>` : ''}</url>`)
      .join('\n')}\n</urlset>\n`,
  );
});

/** RFC 9116: how security researchers can reach us. */
router.get('/.well-known/security.txt', (req, res) => {
  const expires = new Date(Date.now() + 365 * 24 * 3600_000).toISOString();
  res.type('text/plain').send(
    [`Contact: mailto:${config.SUPPORT_EMAIL}`, `Expires: ${expires}`, 'Preferred-Languages: en, fr', `Canonical: ${config.appUrl}/.well-known/security.txt`, `Policy: ${config.appUrl}/privacy`, ''].join('\n'),
  );
});

// ---------- About and policies ----------
const flagship = () => one('SELECT * FROM courses WHERE is_published ORDER BY created_at LIMIT 1');

router.get('/about', async (req, res) => res.render('public/about', { title: 'About us', course: await flagship() }));

router.get('/policies', (req, res) => res.render('public/policies/index', { title: 'Policies', policies: POLICIES, updated: POLICIES_UPDATED }));

for (const policy of POLICIES) {
  router.get(policy.path, async (req, res) =>
    res.render(`public/policies/${policy.view}`, {
      title: policy.title,
      policy,
      policies: POLICIES,
      updated: POLICIES_UPDATED,
      // Exam rules, prices and retention periods come from the live settings, so the policies can't drift from them.
      course: await flagship(),
      retentionDays: config.PROCTOR_RETENTION_DAYS,
      decisionDays: config.PROCTOR_RETENTION_AFTER_DECISION_DAYS,
    }));
}

export default router;
