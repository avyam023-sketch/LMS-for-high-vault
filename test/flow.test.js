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
import { courseOutline, reviewAttempt } from '../src/lib/exam.js';

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

// Minimal files with the right leading bytes; the server checks magic numbers, not just Content-Type.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(256, 2)]);

async function answerQuizCorrectly(agent, moduleId) {
  const qs = await many(`SELECT id FROM questions WHERE module_id = $1 AND pool = 'quiz' AND is_active ORDER BY position, created_at`, [moduleId]);
  for (const q of qs) {
    const correct = (await many('SELECT id FROM question_options WHERE question_id = $1 AND is_correct', [q.id])).map((r) => r.id);
    const url = `/learn/${SLUG}/modules/${moduleId}/quiz`;
    const token = await csrf(agent, url);
    await agent.post(url).type('form').send({ _csrf: token, question_id: q.id, option: correct }).expect(302);
  }
}

/** Works through every chapter and module quiz in order, as a learner would. */
async function completeCourse(agent, email) {
  const user = await one('SELECT id FROM users WHERE email = $1', [email]);
  const outline = await courseOutline(course.id, user.id);
  for (const item of outline.items) {
    if (item.type === 'lesson') {
      await agent.get(`/learn/${SLUG}/lessons/${item.id}`).expect(200);
      // Simulate the study time the heartbeat would have credited.
      await query('UPDATE lesson_progress SET seconds_spent = $3 WHERE user_id = $1 AND lesson_id = $2', [user.id, item.id, item.min_seconds]);
      const token = await csrf(agent, `/learn/${SLUG}/lessons/${item.id}`);
      await agent.post(`/learn/lessons/${item.id}/complete`).type('form').send({ _csrf: token }).expect(302);
    } else {
      await answerQuizCorrectly(agent, item.module_id);
    }
  }
  assert.equal((await courseOutline(course.id, user.id)).allDone, true);
  return user;
}

const PLEDGES = { agree_rules: 'on', agree_alone: 'on', agree_devices: 'on', agree_recording: 'on' };

/** Starts check-in (the exam timer has not started yet). */
async function startCheckin(agent) {
  const token = await csrf(agent, `/learn/${SLUG}/exam`);
  const res = await agent.post(`/learn/${SLUG}/exam/start`).type('form').send({ _csrf: token, ...PLEDGES });
  assert.equal(res.status, 302);
  const m = res.headers.location.match(/^\/exam\/([0-9a-f-]{36})$/);
  assert.ok(m, `unexpected redirect ${res.headers.location}`);
  return { attemptId: m[1], token };
}

const upload = (agent, attemptId, token, kind, type, body) =>
  agent.post(`/exam/${attemptId}/media?kind=${kind}`).set('x-csrf-token', token).set('Content-Type', type).send(body);

/** Check-in with face photo, ID photo and room scan, then begin. */
async function startExam(agent) {
  const { attemptId, token } = await startCheckin(agent);
  await upload(agent, attemptId, token, 'face', 'image/jpeg', JPEG).expect(200);
  await upload(agent, attemptId, token, 'id', 'image/jpeg', JPEG).expect(200);
  await upload(agent, attemptId, token, 'room_scan', 'video/webm', WEBM).expect(200);
  const res = await agent.post(`/exam/${attemptId}/begin`).set('x-csrf-token', token).send({ confirm: true }).expect(200);
  assert.equal(res.body.redirect, `/exam/${attemptId}`);
  return { attemptId, token };
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

test('full learner journey: chapters + quizzes → proctored exam → review → certificate', async () => {
  const email = 'pass@example.com';
  const agent = await verifiedLearner(email, { first: 'Amélie', last: "O'Neil" });
  const me = await one('SELECT reference FROM users WHERE email = $1', [email]);
  assert.match(me.reference, /^HV-L-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  const welcome = lastMailTo(email);
  assert.match(welcome.subject, /Welcome/);
  assert.ok(welcome.text.includes(me.reference), 'welcome email quotes the learner ID');
  let token = await csrf(agent, '/dashboard');
  await agent.post(`/enroll/${SLUG}`).type('form').send({ _csrf: token }).expect(302);

  // Exam is locked until every chapter and quiz is done.
  let res = await agent.get(`/learn/${SLUG}/exam`).expect(200);
  assert.match(res.text, /Finish the modules first/);

  // Chapters unlock in order: chapter 2 is locked until chapter 1 *and* the module 1 quiz are done.
  const lessons = await many(
    `SELECT l.id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = $1 ORDER BY m.position, l.position`,
    [course.id],
  );
  assert.equal(lessons.length, 10);
  res = await agent.get(`/learn/${SLUG}/lessons/${lessons[1].id}`);
  assert.equal(res.status, 302, 'chapter 2 should be locked');

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

  await completeCourse(agent, email);

  const { attemptId } = await startExam(agent);
  const paper = await agent.get(`/exam/${attemptId}/paper`).expect(200);
  assert.equal(paper.body.questions.length, course.exam_question_count);
  assert.equal(new Set(paper.body.questions.map((q) => q.id)).size, course.exam_question_count, 'no duplicate questions');
  const keys = new Set();
  JSON.stringify(paper.body, (k, v) => (keys.add(k), v));
  for (const k of keys) assert.ok(!/correct|explanation|module/i.test(k), `answer key leaked via "${k}"`);

  // A second start while in progress resumes the same attempt.
  token = await csrf(agent, `/learn/${SLUG}/exam`);
  res = await agent.post(`/learn/${SLUG}/exam/start`).type('form').send({ _csrf: token, ...PLEDGES });
  assert.equal(res.headers.location, `/exam/${attemptId}`);

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

  // Proctored pass: the certificate waits for identity review.
  assert.match(res.text, /Certificate pending review/);
  const examRef = (await one('SELECT reference FROM exam_attempts WHERE id = $1', [attemptId])).reference;
  assert.match(examRef, /^HV-E-/);
  assert.ok(res.text.includes(examRef), 'result page shows the exam reference');
  const resultMail = lastMailTo(email);
  assert.match(resultMail.subject, /You passed/);
  assert.ok(resultMail.text.includes(examRef) && /checks your ID/.test(resultMail.text));
  assert.equal((await one('SELECT count(*)::int AS n FROM certificates WHERE attempt_id = $1', [attemptId])).n, 0);
  assert.equal((await one('SELECT review_status FROM exam_attempts WHERE id = $1', [attemptId])).review_status, 'pending');
  res = await agent.get(`/learn/${SLUG}/exam`).expect(200);
  assert.match(res.text, /review in progress/);
  const reviewed = await reviewAttempt(attemptId, null, 'approve', 'ID matches');
  assert.ok(reviewed.certificate);

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
  const user = await completeCourse(agent, email);
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
  // Face detection and noise are logged for the reviewer but never count toward auto-submit.
  for (const kind of ['no_face', 'multiple_faces', 'noise']) {
    await query(`UPDATE integrity_events SET occurred_at = now() - interval '1 minute' WHERE attempt_id = $1`, [second.attemptId]);
    res = await ev(kind).expect(200);
    assert.equal(res.body.violations, 1, `${kind} must not count as a warning`);
  }
  // A second screen does count.
  await query(`UPDATE integrity_events SET occurred_at = now() - interval '1 minute' WHERE attempt_id = $1`, [second.attemptId]);
  res = await ev('second_screen').expect(200);
  assert.equal(res.body.violations, 2);
  // Snapshots are accepted during the exam.
  await upload(agent, second.attemptId, token, 'snapshot', 'image/jpeg', JPEG).expect(200);
  for (let i = 0; i < course.max_focus_violations - 1; i++) {
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

test('module quizzes: answer correctly to advance; strict unlock order', async () => {
  const email = 'quiz@example.com';
  const agent = await verifiedLearner(email);
  let token = await csrf(agent, '/dashboard');
  await agent.post(`/enroll/${SLUG}`).type('form').send({ _csrf: token }).expect(302);
  const user = await one('SELECT id FROM users WHERE email = $1', [email]);
  const outline = await courseOutline(course.id, user.id);
  assert.equal(outline.modules.length, 10);
  assert.equal(outline.items.length, 20, '10 chapters + 10 quizzes');
  const [chapter1, quiz1, chapter2] = outline.items;
  assert.equal(quiz1.type, 'quiz');
  const quizUrl = `/learn/${SLUG}/modules/${quiz1.module_id}/quiz`;

  // The quiz is locked until its chapter is complete.
  let res = await agent.get(quizUrl);
  assert.equal(res.status, 302);
  await agent.get(`/learn/${SLUG}/lessons/${chapter1.id}`).expect(200);
  await query('UPDATE lesson_progress SET seconds_spent = 9999 WHERE user_id = $1 AND lesson_id = $2', [user.id, chapter1.id]);
  token = await csrf(agent, `/learn/${SLUG}/lessons/${chapter1.id}`);
  res = await agent.post(`/learn/lessons/${chapter1.id}/complete`).type('form').send({ _csrf: token });
  assert.equal(res.headers.location, quizUrl, 'completing a chapter leads to its quiz');

  const qs = await many(`SELECT id FROM questions WHERE module_id = $1 AND pool = 'quiz' ORDER BY position`, [quiz1.module_id]);
  const opts = async (qid, correct) => (await many('SELECT id FROM question_options WHERE question_id = $1 AND is_correct = $2', [qid, correct])).map((r) => r.id);
  res = await agent.get(quizUrl).expect(200);
  assert.match(res.text, /Question 1 of 4/);
  // Quiz pages never expose which answer is right before it's answered.
  assert.ok(!res.text.includes('is-correct'));

  // A wrong answer keeps the learner on the same question.
  token = csrfFrom(res.text);
  await agent.post(quizUrl).type('form').send({ _csrf: token, question_id: qs[0].id, option: (await opts(qs[0].id, false))[0] }).expect(302);
  res = await agent.get(quizUrl).expect(200);
  assert.match(res.text, /Not quite/);
  assert.match(res.text, /Question 1 of 4/);

  // Can't skip ahead by answering a later question.
  token = csrfFrom(res.text);
  await agent.post(quizUrl).type('form').send({ _csrf: token, question_id: qs[1].id, option: await opts(qs[1].id, true) }).expect(302);
  assert.equal((await one('SELECT count(*)::int AS n FROM quiz_answers WHERE user_id = $1 AND question_id = $2', [user.id, qs[1].id])).n, 0);

  // The correct answer shows the explanation, then moves on.
  token = csrfFrom((await agent.get(quizUrl)).text);
  await agent.post(quizUrl).type('form').send({ _csrf: token, question_id: qs[0].id, option: await opts(qs[0].id, true) }).expect(302);
  res = await agent.get(quizUrl).expect(200);
  assert.match(res.text, /Correct\./);
  res = await agent.get(quizUrl).expect(200);
  assert.match(res.text, /Question 2 of 4/);

  // Chapter 2 stays locked until the whole quiz is done.
  assert.equal((await agent.get(`/learn/${SLUG}/lessons/${chapter2.id}`)).status, 302);
  await answerQuizCorrectly(agent, quiz1.module_id);
  res = await agent.get(quizUrl).expect(200);
  assert.match(res.text, /Finish quiz/); // feedback for the last answer first
  res = await agent.get(quizUrl).expect(200);
  assert.match(res.text, /Module 1 complete/);
  await agent.get(`/learn/${SLUG}/lessons/${chapter2.id}`).expect(200);
});

test('proctored check-in: nothing is served until ID, face and room scan are in', async () => {
  const email = 'checkin@example.com';
  const agent = await verifiedLearner(email);
  let token = await csrf(agent, '/dashboard');
  await agent.post(`/enroll/${SLUG}`).type('form').send({ _csrf: token }).expect(302);
  await completeCourse(agent, email);

  // Every pledge is required.
  token = await csrf(agent, `/learn/${SLUG}/exam`);
  let res = await agent.post(`/learn/${SLUG}/exam/start`).type('form').send({ _csrf: token, agree_rules: 'on' });
  assert.equal(res.headers.location, `/learn/${SLUG}/exam`);

  const { attemptId } = await startCheckin(agent);
  token = await csrf(agent, '/dashboard');
  res = await agent.get(`/exam/${attemptId}`).expect(200);
  assert.match(res.text, /Exam check-in/);
  await agent.get(`/exam/${attemptId}/paper`).expect(409);
  await agent.post(`/exam/${attemptId}/answer`).set('x-csrf-token', token).send({ questionId: '00000000-0000-0000-0000-000000000000', optionIds: [] }).expect(409);

  // Uploads are checked by content, not just by label, and only allowed at the right stage.
  await upload(agent, attemptId, token, 'face', 'image/jpeg', Buffer.from('<html>not an image</html>')).expect(400);
  await upload(agent, attemptId, token, 'room_scan', 'image/jpeg', JPEG).expect(400);
  await upload(agent, attemptId, token, 'snapshot', 'image/jpeg', JPEG).expect(409);
  await upload(agent, attemptId, token, 'face', 'image/jpeg', JPEG).set('x-csrf-token', 'wrong').expect(403);

  // Begin is refused until all three check-in items exist.
  await upload(agent, attemptId, token, 'face', 'image/jpeg', JPEG).expect(200);
  res = await agent.post(`/exam/${attemptId}/begin`).set('x-csrf-token', token).send({ confirm: true }).expect(400);
  assert.match(res.body.error, /id, room scan/);
  await upload(agent, attemptId, token, 'id', 'image/jpeg', JPEG).expect(200);
  await upload(agent, attemptId, token, 'id', 'image/jpeg', JPEG).expect(200); // retake replaces
  await upload(agent, attemptId, token, 'room_scan', 'video/webm', WEBM).expect(200);
  assert.equal((await one(`SELECT count(*)::int AS n FROM proctor_media WHERE attempt_id = $1 AND kind = 'id'`, [attemptId])).n, 1);
  // Stored encrypted, never as the raw upload.
  const stored = await one(`SELECT data FROM proctor_media WHERE attempt_id = $1 AND kind = 'id'`, [attemptId]);
  assert.notDeepEqual(stored.data.subarray(0, 4), JPEG.subarray(0, 4));
  await agent.post(`/exam/${attemptId}/begin`).set('x-csrf-token', token).send({}).expect(400);

  // Cancelling check-in discards it without using an attempt.
  res = await agent.post(`/exam/${attemptId}/cancel`).type('form').send({ _csrf: token }).expect(302);
  assert.equal(await one('SELECT id FROM exam_attempts WHERE id = $1', [attemptId]), null);

  // The clock starts at "begin", not at check-in.
  const { attemptId: second } = await startCheckin(agent);
  await query(`UPDATE exam_attempts SET checkin_started_at = now() - interval '20 minutes' WHERE id = $1`, [second]);
  await upload(agent, second, token, 'face', 'image/jpeg', JPEG).expect(200);
  await upload(agent, second, token, 'id', 'image/jpeg', JPEG).expect(200);
  await upload(agent, second, token, 'room_scan', 'video/webm', WEBM).expect(200);
  await agent.post(`/exam/${second}/begin`).set('x-csrf-token', token).send({ confirm: true }).expect(200);
  const a = await one('SELECT status, started_at, expires_at FROM exam_attempts WHERE id = $1', [second]);
  assert.equal(a.status, 'in_progress');
  const minutes = (new Date(a.expires_at) - Date.now()) / 60000;
  assert.ok(minutes > course.exam_time_limit_minutes - 1 && minutes <= course.exam_time_limit_minutes, `timer ${minutes} min`);
  await agent.get(`/exam/${second}/paper`).expect(200);

  // A lapsed check-in is dropped and doesn't count.
  await agent.post(`/exam/${second}/submit`).type('form').send({ _csrf: token }).expect(302);
  await query(`UPDATE exam_attempts SET submitted_at = now() - interval '2 hours' WHERE id = $1`, [second]);
  const { attemptId: third } = await startCheckin(agent);
  await query(`UPDATE exam_attempts SET checkin_started_at = now() - interval '45 minutes' WHERE id = $1`, [third]);
  res = await agent.get(`/exam/${third}`);
  assert.equal(res.status, 302);
  assert.equal(await one('SELECT id FROM exam_attempts WHERE id = $1', [third]), null);
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

  // Identity review: a passed, proctored attempt waits in the queue until an admin decides.
  const pendingUser = await one(`SELECT id FROM users WHERE email = 'checkin@example.com'`);
  const pendingAttempt = await one(
    `SELECT a.id FROM exam_attempts a JOIN proctor_media p ON p.attempt_id = a.id WHERE a.user_id = $1 AND a.status = 'submitted' LIMIT 1`,
    [pendingUser.id],
  );
  await query(`UPDATE exam_attempts SET passed = true, score_percent = 90, review_status = 'pending' WHERE id = $1`, [pendingAttempt.id]);
  res = await fresh.get('/admin/attempts?filter=review').expect(200);
  assert.ok(res.text.includes(`/admin/attempts/${pendingAttempt.id}`));
  res = await fresh.get(`/admin/attempts/${pendingAttempt.id}`).expect(200);
  assert.match(res.text, /Identity check/);
  assert.match(res.text, /Approve and issue certificate/);
  const media = await many('SELECT id, kind FROM proctor_media WHERE attempt_id = $1', [pendingAttempt.id]);
  const idMedia = media.find((m) => m.kind === 'id');
  const img = await fresh.get(`/admin/media/${idMedia.id}`).buffer(true).parse((r, cb) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  }).expect(200);
  assert.deepEqual([...img.body.subarray(0, 3)], [0xff, 0xd8, 0xff], 'served decrypted');
  assert.equal(img.headers['cache-control'], 'no-store');
  const scan = media.find((m) => m.kind === 'room_scan');
  res = await fresh.get(`/admin/media/${scan.id}`).set('Range', 'bytes=0-3').expect(206);
  assert.match(res.headers['content-range'], /^bytes 0-3\/\d+$/);
  await learner.get(`/admin/media/${idMedia.id}`).expect(404);

  token = await csrf(fresh, `/admin/attempts/${pendingAttempt.id}`);
  await fresh.post(`/admin/attempts/${pendingAttempt.id}/review`).type('form').send({ _csrf: token, decision: 'reject', note: '' }).expect(302);
  assert.equal((await one('SELECT review_status FROM exam_attempts WHERE id = $1', [pendingAttempt.id])).review_status, 'pending');
  await fresh.post(`/admin/attempts/${pendingAttempt.id}/review`).type('form').send({ _csrf: token, decision: 'approve', note: 'ID matches' }).expect(302);
  const issued = await one('SELECT code FROM certificates WHERE attempt_id = $1', [pendingAttempt.id]);
  assert.ok(issued, 'approval issues the certificate');
  const certMail = lastMailTo('checkin@example.com');
  assert.match(certMail.subject, /certificate is ready/);
  assert.ok(certMail.text.includes(issued.code) && certMail.html.includes(issued.code));

  // One search box finds any reference code.
  const refs = await one(
    `SELECT u.reference AS learner, a.reference AS exam FROM exam_attempts a JOIN users u ON u.id = a.user_id WHERE a.id = $1`,
    [pendingAttempt.id],
  );
  res = await fresh.get(`/admin/find?code=${encodeURIComponent(refs.exam.toLowerCase())}`).expect(302);
  assert.equal(res.headers.location, `/admin/attempts/${pendingAttempt.id}`);
  res = await fresh.get(`/admin/find?code=${refs.learner}`).expect(302);
  assert.equal(res.headers.location, `/admin/users/${pendingUser.id}`);
  res = await fresh.get(`/admin/find?code=${issued.code}`).expect(302);
  assert.match(res.headers.location, /^\/admin\/certificates\?q=/);
  res = await fresh.get('/admin/find?code=HV-E-2222-2222').expect(302);
  assert.equal(res.headers.location, '/admin');
  res = await fresh.get('/admin/users?q=' + refs.learner).expect(200);
  assert.ok(res.text.includes(`/admin/users/${pendingUser.id}`));

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
