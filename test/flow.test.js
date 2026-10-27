import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import * as OTPAuth from 'otpauth';
import { pool, query, one, many } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { createApp } from '../src/app.js';
import { outbox } from '../src/lib/mailer.js';
import { hashPassword } from '../src/lib/passwords.js';

const SLUG = 'food-handler-certification';
let app;
let course;

const csrfFrom = (html) => html.match(/name="_csrf" value="([^"]+)"/)?.[1];
async function csrf(agent, url = '/login') {
  const res = await agent.get(url);
  const token = csrfFrom(res.text);
  assert.ok(token, `no CSRF token on ${url}`);
  return token;
}
const lastMailTo = (email) => [...outbox].reverse().find((m) => m.to === email);

async function register(agent, { email, first = 'Jordan', last = 'Lee', password = 'correct horse battery staple' }) {
  const token = await csrf(agent, '/register');
  return agent.post('/register').type('form').send({
    _csrf: token, first_name: first, last_name: last, email, password, confirm: password, terms: 'on',
  });
}

async function verifiedLearner(email, name = {}) {
  const agent = request.agent(app);
  const res = await register(agent, { email, ...name });
  assert.equal(res.status, 302);
  const link = lastMailTo(email).text.match(/\/verify-email\/([\w-]+)/)[1];
  await agent.get(`/verify-email/${link}`).expect(302);
  return agent;
}

async function completeAllLessons(agent, email) {
  const user = await one('SELECT id FROM users WHERE email = $1', [email]);
  const lessons = await many(
    `SELECT l.id, l.min_seconds FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = $1 ORDER BY m.position, l.position`,
    [course.id],
  );
  for (const l of lessons) {
    await agent.get(`/learn/${SLUG}/lessons/${l.id}`).expect(200);
    // Simulate the study time the heartbeat would have credited.
    await query('UPDATE lesson_progress SET seconds_spent = $3 WHERE user_id = $1 AND lesson_id = $2', [user.id, l.id, l.min_seconds]);
    const token = await csrf(agent, `/learn/${SLUG}/lessons/${l.id}`);
    await agent.post(`/learn/lessons/${l.id}/complete`).type('form').send({ _csrf: token }).expect(302);
  }
  return user;
}

async function startExam(agent) {
  const token = await csrf(agent, `/learn/${SLUG}/exam`);
  const res = await agent.post(`/learn/${SLUG}/exam/start`).type('form').send({ _csrf: token, agree: 'on' });
  assert.equal(res.status, 302);
  const m = res.headers.location.match(/^\/exam\/([0-9a-f-]{36})$/);
  assert.ok(m, `unexpected redirect ${res.headers.location}`);
  return { attemptId: m[1], token };
}

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate({ log: () => {} });
  await seed({ log: () => {} });
  app = createApp();
  course = await one('SELECT * FROM courses WHERE slug = $1', [SLUG]);
});

after(() => pool.end());

test('public course page and security headers', async () => {
  const res = await request(app).get('/').expect(200);
  assert.match(res.text, /Food Handler Certification/);
  assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-powered-by'], undefined);
  assert.equal(res.headers['set-cookie'], undefined, 'anonymous visitors without forms get no session');
});

test('registration validates input and never reveals existing accounts', async () => {
  const agent = request.agent(app);
  let res = await register(agent, { email: 'weak@example.com', password: 'short' });
  assert.equal(res.status, 422);
  assert.match(res.text, /at least 12 characters/);

  res = await register(agent, { email: 'dup@example.com' });
  assert.equal(res.status, 302);
  const other = request.agent(app);
  res = await register(other, { email: 'DUP@example.com' });
  assert.equal(res.status, 200);
  assert.match(res.text, /Check your email/);
  assert.match(lastMailTo('dup@example.com').subject, /Sign-in help/);
  assert.equal((await one(`SELECT count(*)::int AS n FROM users WHERE email = 'dup@example.com'`)).n, 1);
});

test('email must be verified before learning', async () => {
  const agent = request.agent(app);
  await register(agent, { email: 'unverified@example.com' });
  const res = await agent.get('/dashboard');
  assert.equal(res.headers.location, '/verify-email');
  await agent.get('/verify-email/not-a-real-token').expect(400);
});

test('CSRF token is required for state-changing requests', async () => {
  const agent = await verifiedLearner('csrf@example.com');
  await agent.post(`/enroll/${SLUG}`).type('form').send({}).expect(403);
});

test('full learner journey: lessons → exam → certificate → verification', async () => {
  const email = 'pass@example.com';
  const agent = await verifiedLearner(email, { first: 'Amélie', last: "O'Neil" });
  let token = await csrf(agent, '/dashboard');
  await agent.post(`/enroll/${SLUG}`).type('form').send({ _csrf: token }).expect(302);

  // Exam is locked until lessons are done.
  let res = await agent.get(`/learn/${SLUG}/exam`).expect(200);
  assert.match(res.text, /Finish the lessons first/);

  // Lessons unlock in order.
  const lessons = await many(
    `SELECT l.id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = $1 ORDER BY m.position, l.position`,
    [course.id],
  );
  res = await agent.get(`/learn/${SLUG}/lessons/${lessons[2].id}`);
  assert.equal(res.status, 302, 'third lesson should be locked');

  // Minimum study time is enforced server-side.
  await agent.get(`/learn/${SLUG}/lessons/${lessons[0].id}`).expect(200);
  token = await csrf(agent, `/learn/${SLUG}/lessons/${lessons[0].id}`);
  await agent.post(`/learn/lessons/${lessons[0].id}/complete`).type('form').send({ _csrf: token }).expect(302);
  const user = await one('SELECT id FROM users WHERE email = $1', [email]);
  assert.equal((await one('SELECT completed_at FROM lesson_progress WHERE user_id = $1 AND lesson_id = $2', [user.id, lessons[0].id])).completed_at, null);

  // Heartbeats can't be spammed to fake study time.
  for (let i = 0; i < 5; i++) {
    const hb = await agent.post(`/learn/lessons/${lessons[0].id}/heartbeat`).set('x-csrf-token', token).send({}).expect(200);
    assert.ok(hb.body.seconds <= 2, `credited ${hb.body.seconds}s for instant heartbeats`);
  }

  await completeAllLessons(agent, email);

  const { attemptId } = await startExam(agent);
  const paper = await agent.get(`/exam/${attemptId}/paper`).expect(200);
  assert.equal(paper.body.questions.length, course.exam_question_count);
  assert.equal(new Set(paper.body.questions.map((q) => q.id)).size, course.exam_question_count, 'no duplicate questions');
  const keys = new Set();
  JSON.stringify(paper.body, (k, v) => (keys.add(k), v));
  for (const k of keys) assert.ok(!/correct|explanation|module/i.test(k), `answer key leaked via "${k}"`);

  // A second start while in progress resumes the same attempt.
  const again = await startExam(agent);
  assert.equal(again.attemptId, attemptId);

  // Can't answer with an option from another question.
  const [q1, q2] = paper.body.questions;
  token = await csrf(agent, '/dashboard');
  await agent.post(`/exam/${attemptId}/answer`).set('x-csrf-token', token).send({ questionId: q1.id, optionIds: [q2.options[0].id] }).expect(400);
  await agent.post(`/exam/${attemptId}/answer`).send({ questionId: q1.id, optionIds: [q1.options[0].id] }).expect(403);

  // Answer every question correctly (looked up server-side, as the grader does).
  for (const q of paper.body.questions) {
    const correct = (await many('SELECT id FROM question_options WHERE question_id = $1 AND is_correct', [q.id])).map((r) => r.id);
    await agent.post(`/exam/${attemptId}/answer`).set('x-csrf-token', token).send({ questionId: q.id, optionIds: correct }).expect(200);
  }
  res = await agent.post(`/exam/${attemptId}/submit`).type('form').send({ _csrf: token }).expect(302);
  res = await agent.get(`/exam/${attemptId}/result`).expect(200);
  assert.match(res.text, /class="score">100</);
  assert.match(res.text, /You passed/);

  const cert = await one('SELECT * FROM certificates WHERE attempt_id = $1', [attemptId]);
  assert.ok(cert);
  assert.match(cert.code, /^HV-\d{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(cert.full_name, "Amélie O'Neil");

  const pdf = await agent.get(`/certificates/${cert.code}.pdf`).buffer(true).parse((r, cb) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');

  res = await request(app).get(`/verify/${cert.code}`).expect(200);
  assert.match(res.text, /Valid certificate/);
  assert.match(res.text, /Amélie O&#39;Neil/);

  // Can't retake once certified; can't download someone else's certificate.
  res = await agent.get(`/learn/${SLUG}/exam`).expect(200);
  assert.match(res.text, /You passed/);
  const stranger = await verifiedLearner('stranger@example.com');
  await stranger.get(`/certificates/${cert.code}.pdf`).expect(404);

  // Name is locked once a certificate exists.
  token = await csrf(agent, '/account');
  await agent.post('/account/profile').type('form').send({ _csrf: token, first_name: 'Someone', last_name: 'Else' }).expect(302);
  assert.equal((await one('SELECT first_name FROM users WHERE email = $1', [email])).first_name, 'Amélie');
});

test('exam integrity: time limit, focus violations, cooldown and attempt limits', async () => {
  const email = 'fail@example.com';
  const agent = await verifiedLearner(email);
  let token = await csrf(agent, '/dashboard');
  await agent.post(`/enroll/${SLUG}`).type('form').send({ _csrf: token }).expect(302);
  const user = await completeAllLessons(agent, email);
  token = await csrf(agent, '/dashboard');

  // 1. Expired timer: answers are refused and the attempt is auto-submitted.
  const first = await startExam(agent);
  await query(`UPDATE exam_attempts SET expires_at = now() - interval '5 minutes' WHERE id = $1`, [first.attemptId]);
  const paper = await agent.get(`/exam/${first.attemptId}/paper`);
  assert.equal(paper.status, 409);
  const a1 = await one('SELECT * FROM exam_attempts WHERE id = $1', [first.attemptId]);
  assert.equal(a1.status, 'submitted');
  assert.equal(a1.auto_submitted, 'time');
  assert.equal(a1.passed, false);
  assert.equal((await one('SELECT count(*)::int AS n FROM certificates WHERE attempt_id = $1', [first.attemptId])).n, 0);

  // 2. Cooldown blocks an immediate retake.
  let res = await agent.get(`/learn/${SLUG}/exam`).expect(200);
  assert.match(res.text, /Take a short break/);
  await query(`UPDATE exam_attempts SET submitted_at = now() - interval '2 hours' WHERE user_id = $1`, [user.id]);

  // 3. Leaving the exam too often ends it.
  const second = await startExam(agent);
  const ev = (kind) => agent.post(`/exam/${second.attemptId}/event`).set('x-csrf-token', token).send({ kind });
  res = await ev('window_blur').expect(200);
  assert.equal(res.body.violations, 1);
  res = await ev('tab_hidden').expect(200);
  assert.equal(res.body.violations, 1, 'blur + hidden from one tab switch count once');
  await ev('copy').expect(200);
  await ev('made_up_event').expect(400);
  for (let i = 0; i < course.max_focus_violations; i++) {
    await query(`UPDATE integrity_events SET occurred_at = now() - interval '1 minute' WHERE attempt_id = $1`, [second.attemptId]);
    res = await ev('fullscreen_exit').expect(200);
  }
  assert.equal(res.body.terminated, true);
  const a2 = await one('SELECT * FROM exam_attempts WHERE id = $1', [second.attemptId]);
  assert.equal(a2.auto_submitted, 'integrity');
  res = await agent.get(`/exam/${second.attemptId}/result`).expect(200);
  assert.match(res.text, /left the exam page too many times/);
  assert.ok(!/correct\b.*✓/.test(res.text));

  // 4. Attempt limit.
  await query(`UPDATE exam_attempts SET submitted_at = now() - interval '2 hours' WHERE user_id = $1`, [user.id]);
  const third = await startExam(agent);
  await agent.post(`/exam/${third.attemptId}/submit`).type('form').send({ _csrf: token }).expect(302);
  await query(`UPDATE exam_attempts SET submitted_at = now() - interval '2 hours' WHERE user_id = $1`, [user.id]);
  res = await agent.get(`/learn/${SLUG}/exam`).expect(200);
  assert.match(res.text, /No attempts left/);

  // Another learner can't touch this attempt.
  const other = await verifiedLearner('other@example.com');
  await other.get(`/exam/${third.attemptId}/paper`).expect(404);
});

test('sign-in: lockout, single active session, sign-out', async () => {
  const email = 'session@example.com';
  await verifiedLearner(email);
  const login = async (agent, password) => {
    const token = await csrf(agent, '/login');
    return agent.post('/login').type('form').send({ _csrf: token, email, password });
  };
  const a = request.agent(app);
  assert.equal((await login(a, 'correct horse battery staple')).status, 302);
  await a.get('/dashboard').expect(200);

  // Signing in elsewhere ends the first session (stops account sharing).
  const b = request.agent(app);
  assert.equal((await login(b, 'correct horse battery staple')).status, 302);
  await b.get('/dashboard').expect(200);
  const kicked = await a.get('/dashboard');
  assert.equal(kicked.status, 302);
  assert.equal(kicked.headers.location, '/login');

  // Five wrong passwords lock the account, even for the right password.
  const c = request.agent(app);
  for (let i = 0; i < 5; i++) assert.equal((await login(c, 'wrong password attempt')).status, 401);
  const locked = await login(c, 'correct horse battery staple');
  assert.equal(locked.status, 401);
  assert.match(locked.text, /locked/);

  // Unknown email gets the same generic message.
  const token = await csrf(c, '/login');
  const res = await c.post('/login').type('form').send({ _csrf: token, email: 'nobody@example.com', password: 'whatever whatever' });
  assert.equal(res.status, 401);
  assert.match(res.text, /Email or password is incorrect/);
});

test('password reset flow', async () => {
  const email = 'reset@example.com';
  await verifiedLearner(email);
  const agent = request.agent(app);
  let token = await csrf(agent, '/forgot-password');
  await agent.post('/forgot-password').type('form').send({ _csrf: token, email }).expect(200);
  const link = lastMailTo(email).text.match(/\/reset-password\/([\w-]+)/)[1];
  token = await csrf(agent, `/reset-password/${link}`);
  await agent.post(`/reset-password/${link}`).type('form').send({ _csrf: token, password: 'a brand new long passphrase', confirm: 'a brand new long passphrase' }).expect(302);
  // Single use.
  await agent.get(`/reset-password/${link}`).expect(400);
  token = await csrf(agent, '/login');
  const res = await agent.post('/login').type('form').send({ _csrf: token, email, password: 'a brand new long passphrase' });
  assert.equal(res.status, 302);
});

test('admin area: hidden from learners, requires MFA, manages certificates', async () => {
  const learner = await verifiedLearner('nosy@example.com');
  await learner.get('/admin').expect(404);

  await query(
    `INSERT INTO users (email, password_hash, first_name, last_name, role, email_verified_at) VALUES ($1, $2, 'Avery', 'Admin', 'admin', now())`,
    ['boss@example.com', await hashPassword('admin passphrase for tests')],
  );
  const admin = request.agent(app);
  let token = await csrf(admin, '/login');
  await admin.post('/login').type('form').send({ _csrf: token, email: 'boss@example.com', password: 'admin passphrase for tests' }).expect(302);

  // MFA setup is forced before the dashboard opens.
  let res = await admin.get('/admin');
  assert.equal(res.headers.location, '/account/mfa');
  res = await admin.get('/account/mfa').expect(200);
  const secret = res.text.match(/Setup key: <code>([A-Z2-7 ]+)<\/code>/)[1].replace(/ /g, '');
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
  token = csrfFrom(res.text);
  await admin.post('/account/mfa').type('form').send({ _csrf: token, code: '000000' }).expect(302);
  assert.equal((await one(`SELECT mfa_enabled_at FROM users WHERE email = 'boss@example.com'`)).mfa_enabled_at, null);
  await admin.post('/account/mfa').type('form').send({ _csrf: token, code: totp.generate() }).expect(302);
  await admin.get('/admin').expect(200);

  // Next sign-in needs a code; the same code can't be replayed.
  const fresh = request.agent(app);
  token = await csrf(fresh, '/login');
  res = await fresh.post('/login').type('form').send({ _csrf: token, email: 'boss@example.com', password: 'admin passphrase for tests' });
  assert.equal(res.headers.location, '/login/mfa');
  assert.notEqual((await fresh.get('/admin')).status, 200);
  token = await csrf(fresh, '/login/mfa');
  const code = totp.generate();
  await fresh.post('/login/mfa').type('form').send({ _csrf: token, code }).expect(302);
  await fresh.get('/admin').expect(200);

  // Knowing only the password must not sign the real admin out (MFA not yet passed).
  const halfway = request.agent(app);
  token = await csrf(halfway, '/login');
  res = await halfway.post('/login').type('form').send({ _csrf: token, email: 'boss@example.com', password: 'admin passphrase for tests' });
  assert.equal(res.headers.location, '/login/mfa');
  await fresh.get('/admin').expect(200);

  // Course settings round-trip through the editor.
  token = await csrf(fresh, `/admin/courses/${course.id}`);
  res = await fresh.post(`/admin/courses/${course.id}`).type('form').send({
    _csrf: token, title: course.title, slug: course.slug, subtitle: course.subtitle, description_md: course.description_md,
    highlights: 'One\nTwo', outcomes: 'Learn things', faqs: 'Question one?\nAnswer one.\n\nQuestion two?\nAnswer two.',
    price: '24.99', currency: 'cad', duration_minutes: '240', language: 'English', pass_mark: '70', exam_question_count: '30',
    exam_time_limit_minutes: '60', max_attempts: '3', attempt_cooldown_minutes: '30', max_focus_violations: '3',
    certificate_validity_months: '60', is_published: 'on', require_fullscreen: 'on',
  });
  assert.equal(res.status, 302);
  const saved = await one('SELECT * FROM courses WHERE id = $1', [course.id]);
  assert.equal(saved.price_cents, 2499);
  assert.deepEqual(saved.highlights, ['One', 'Two']);
  assert.deepEqual(saved.faqs, [{ q: 'Question one?', a: 'Answer one.' }, { q: 'Question two?', a: 'Answer two.' }]);
  res = await request(app).get('/').expect(200);
  assert.match(res.text, /\$24\.99/);

  // Admin pages render.
  for (const path of ['/admin', '/admin/users', '/admin/attempts?filter=flagged', '/admin/certificates', '/admin/courses', `/admin/courses/${course.id}`, `/admin/courses/${course.id}/questions`, '/admin/audit']) {
    await fresh.get(path).expect(200);
  }
  const attempt = await one(`SELECT id FROM exam_attempts LIMIT 1`);
  await fresh.get(`/admin/attempts/${attempt.id}`).expect(200);

  // Revoking a certificate shows on the public verification page.
  const cert = await one('SELECT * FROM certificates LIMIT 1');
  token = await csrf(fresh, '/admin/certificates');
  await fresh.post(`/admin/certificates/${cert.id}`).type('form').send({ _csrf: token, action: 'revoke', reason: 'Test' }).expect(302);
  res = await request(app).get(`/verify/${cert.code}`).expect(200);
  assert.match(res.text, /revoked/);

  // CSV export neutralises spreadsheet formulas.
  await query(`UPDATE certificates SET revoke_reason = '=HYPERLINK("http://evil")' WHERE id = $1`, [cert.id]);
  res = await fresh.get('/admin/certificates.csv').expect(200);
  assert.match(res.text, /"'=HYPERLINK/);

  // CSV question import.
  token = await csrf(fresh, `/admin/courses/${course.id}/questions`);
  await fresh
    .post(`/admin/courses/${course.id}/questions/import`)
    .type('form')
    .send({ _csrf: token, csv: 'prompt,a,b,c,d,correct\n"Imported, with comma?",Yes,No,,,A\nbad row,only one,,,,A' })
    .expect(302);
  assert.ok(await one(`SELECT id FROM questions WHERE prompt = 'Imported, with comma?' AND kind = 'single'`));

  // Learner-authored text in lessons is sanitized.
  const lesson = await one('SELECT l.id, l.module_id FROM lessons l LIMIT 1');
  token = await csrf(fresh, `/admin/lessons/${lesson.id}`);
  await fresh.post(`/admin/lessons/${lesson.id}`).type('form').send({
    _csrf: token, title: 'XSS test', module_id: lesson.module_id, min_seconds: 60, position: 1, video_url: '',
    content_md: 'Hello <script>alert(1)</script><img src=x onerror=alert(1)> [x](javascript:alert(1))',
  }).expect(302);
  const passAgent = request.agent(app);
  token = await csrf(passAgent, '/login');
  await passAgent.post('/login').type('form').send({ _csrf: token, email: 'pass@example.com', password: 'correct horse battery staple' }).expect(302);
  res = await passAgent.get(`/learn/${SLUG}/lessons/${lesson.id}`).expect(200);
  assert.ok(!res.text.includes('<script>alert'));
  assert.ok(!res.text.includes('onerror'));
  assert.ok(!res.text.includes('javascript:alert'));

  // A used MFA code can't be replayed (this sign-in also ends the session above: one device at a time).
  const replay = request.agent(app);
  token = await csrf(replay, '/login');
  await replay.post('/login').type('form').send({ _csrf: token, email: 'boss@example.com', password: 'admin passphrase for tests' });
  token = await csrf(replay, '/login/mfa');
  await replay.post('/login/mfa').type('form').send({ _csrf: token, code }).expect(401);
});
