import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { pool, query, one } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { bootstrap } from '../src/lib/bootstrap.js';
import { DEMO_PASSWORD } from '../src/db/sample-data.js';
import { outbox } from '../src/lib/mailer.js';
import { courseOutline } from '../src/lib/exam.js';

const ADMIN = { email: 'owner@thehighvaultsecurity.test', password: 'violet harbour lantern ninety' };
const csrfFrom = (html) => html.match(/name="_csrf" value="([^"]+)"/)?.[1];
const count = async (sql) => (await one(sql)).n;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate({ log: () => {} });
  await seed({ log: () => {} });
});
after(() => pool.end());

test('sample data for a live demo: once, no known passwords, no extra staff, removable', async () => {
  Object.assign(config, { ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password, SEED_SAMPLE_DATA: true, REQUIRE_ADMIN_MFA: false, CHECK_BREACHED_PASSWORDS: false });
  await bootstrap();
  assert.equal(outbox.filter((m) => m.to === ADMIN.email).length, 0, 'loading sample exams emails nobody');
  const learners = await count(`SELECT count(*)::int AS n FROM users WHERE role = 'student' AND is_sample`);
  assert.ok(learners >= 10, 'sample learners loaded');
  assert.equal(await count(`SELECT count(*)::int AS n FROM users WHERE role <> 'student'`), 1, 'only the real admin is staff');
  assert.ok(await count(`SELECT count(*)::int AS n FROM certificates`) >= 3);
  assert.ok(await count(`SELECT count(*)::int AS n FROM exam_attempts WHERE review_status = 'pending'`) >= 1, 'something in the review queue');
  const admin = await one(`SELECT id FROM users WHERE role = 'admin'`);
  assert.ok(await one(`SELECT 1 FROM exam_attempts WHERE reviewed_by = $1`, [admin.id]), 'the real admin approved the sample exams');

  // Booting again changes nothing.
  await bootstrap();
  assert.equal(await count(`SELECT count(*)::int AS n FROM users WHERE role = 'student'`), learners);

  // The preview's known password doesn't open a live sample account.
  const app = createApp();
  const guess = request.agent(app);
  let page = await guess.get('/login');
  let res = await guess.post('/login').type('form').send({ _csrf: csrfFrom(page.text), email: 'alex.morgan@example.com', password: DEMO_PASSWORD });
  assert.notEqual(res.headers.location, '/dashboard');

  // The admin sees the notice and removes everything in one step.
  const agent = request.agent(app);
  page = await agent.get('/login');
  await agent.post('/login').type('form').send({ _csrf: csrfFrom(page.text), ...ADMIN }).expect(302);
  page = await agent.get('/admin').expect(200);
  assert.match(page.text, /Sample data is loaded/);
  // Demo shortcut: skip an enrolled learner to the final exam (only while SEED_SAMPLE_DATA is on).
  const course = await one('SELECT id FROM courses LIMIT 1');
  const real = await one(`INSERT INTO users (email, password_hash, first_name, last_name, email_verified_at) VALUES ('real@thehighvaultsecurity.test', 'x', 'Real', 'Person', now()) RETURNING id`);
  const skip = async () => {
    const p = await agent.get(`/admin/users/${real.id}`).expect(200);
    await agent.post(`/admin/users/${real.id}/action`).type('form').send({ _csrf: csrfFrom(p.text), action: 'demo_complete', course_id: course.id }).expect(302);
    return (await courseOutline(course.id, real.id)).allDone;
  };
  assert.equal(await skip(), false, 'not enrolled: nothing happens');
  await query('INSERT INTO enrollments (user_id, course_id) VALUES ($1, $2)', [real.id, course.id]);
  config.SEED_SAMPLE_DATA = false;
  assert.equal(await skip(), false, 'off outside demo mode');
  config.SEED_SAMPLE_DATA = true;
  assert.equal(await skip(), true);

  res = await agent.post('/admin/sample-data/delete').type('form').send({ _csrf: csrfFrom(page.text) }).expect(302);
  assert.equal(await count(`SELECT count(*)::int AS n FROM users WHERE is_sample`), 0);
  assert.equal(await count(`SELECT count(*)::int AS n FROM certificates`), 0);
  assert.equal(await count(`SELECT count(*)::int AS n FROM users WHERE role = 'admin'`), 1);
  assert.ok(await one(`SELECT 1 FROM users WHERE id = $1`, [real.id]), 'real accounts are kept');
  page = await agent.get('/admin').expect(200);
  assert.doesNotMatch(page.text, /Sample data is loaded/);

  // Removing them doesn't bring them back on the next boot.
  await bootstrap();
  assert.equal(await count(`SELECT count(*)::int AS n FROM users WHERE is_sample`), 0);
});
