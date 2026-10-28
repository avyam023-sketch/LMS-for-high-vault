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
import { decryptBuffer, encrypt, encryptBuffer, needsRotation } from '../src/lib/crypto.js';
import { purgeProctorMedia, sendExpiryReminders } from '../src/lib/maintenance.js';

let app;
const PASSWORD = 'correct horse battery staple';
const csrfFrom = (html) => html.match(/name="_csrf" value="([^"]+)"/)?.[1];
async function csrf(agent, url = '/login') {
  const token = csrfFrom((await agent.get(url)).text);
  assert.ok(token, `no CSRF token on ${url}`);
  return token;
}
const lastMailTo = (email) => [...outbox].reverse().find((m) => m.to === email);

async function learner(email) {
  const agent = request.agent(app);
  const token = await csrf(agent, '/register');
  await agent.post('/register').type('form')
    .send({ _csrf: token, first_name: 'Sam', last_name: 'Rivera', email, password: PASSWORD, confirm: PASSWORD, terms: 'on' })
    .expect(302);
  const link = lastMailTo(email).text.match(/\/verify-email\/([\w-]+)/)[1];
  await agent.get(`/verify-email/${link}`).expect(302);
  return agent;
}

/** A staff member with two-step verification already set up, signed in. */
async function staff(email, role) {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const u = await one(
    `INSERT INTO users (email, password_hash, first_name, last_name, role, email_verified_at, mfa_enabled_at)
     VALUES ($1, $2, 'Pat', 'Staff', $3, now(), now()) RETURNING id`,
    [email, await hashPassword(PASSWORD), role],
  );
  await query('UPDATE users SET mfa_secret_enc = $2 WHERE id = $1', [u.id, encrypt(secret, { purpose: 'mfa', context: u.id })]);
  const agent = request.agent(app);
  let token = await csrf(agent, '/login');
  await agent.post('/login').type('form').send({ _csrf: token, email, password: PASSWORD }).expect(302);
  token = await csrf(agent, '/login/mfa');
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  await agent.post('/login/mfa').type('form').send({ _csrf: token, code }).expect(302);
  return { agent, id: u.id };
}

/** Inserts a submitted, passed attempt with encrypted evidence, awaiting review. */
async function pendingAttemptWithEvidence(email) {
  const user = await one('SELECT id FROM users WHERE email = $1', [email]);
  const course = await one('SELECT id FROM courses LIMIT 1');
  const a = await one(
    `INSERT INTO exam_attempts (user_id, course_id, question_ids, option_order, status, expires_at, submitted_at, score_percent, passed, review_status)
     VALUES ($1, $2, '{}', '{}', 'submitted', now(), now(), 90, true, 'pending') RETURNING id`,
    [user.id, course.id],
  );
  for (const kind of ['face', 'id', 'room_scan']) {
    const body = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    await query('INSERT INTO proctor_media (attempt_id, kind, mime, byte_size, data) VALUES ($1, $2, $3, $4, $5)', [
      a.id, kind, 'image/jpeg', body.length, encryptBuffer(body, { purpose: 'proctor-media', context: `${a.id}:${kind}` }),
    ]);
  }
  return a.id;
}

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate({ log: () => {} });
  await seed({ log: () => {} });
  // These tests enrol for free; paid enrolment (Stripe) is covered separately.
  await query('UPDATE courses SET price_cents = 0');
  app = createApp();
});
after(() => pool.end());

test('encryption: per-purpose keys, bound to the record, rotation-aware', () => {
  const ctx = { purpose: 'proctor-media', context: 'attempt-1:id' };
  const sealed = encryptBuffer(Buffer.from('passport scan'), ctx);
  assert.equal(decryptBuffer(sealed, ctx).toString(), 'passport scan');
  assert.throws(() => decryptBuffer(sealed, { purpose: 'proctor-media', context: 'attempt-2:id' }), 'moved to another record');
  assert.throws(() => decryptBuffer(sealed, { purpose: 'mfa', context: 'attempt-1:id' }), 'used for another purpose');
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptBuffer(tampered, ctx), 'tampering is detected');
  assert.equal(needsRotation(sealed), false);
});

test('headers and request hygiene', async () => {
  const res = await request(app).get('/').expect(200);
  assert.ok(res.headers['x-request-id']);
  assert.match(res.headers['permissions-policy'], /camera=\(self\)/);
  assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin');

  // Signed-in pages are never cached.
  const agent = await learner('cache@example.com');
  const dash = await agent.get('/dashboard').expect(200);
  assert.equal(dash.headers['cache-control'], 'no-store');

  // Cross-site form posts are refused even with a valid token.
  const token = await csrf(agent, '/account');
  await agent.post('/account/profile').set('Origin', 'https://evil.example').type('form').send({ _csrf: token, first_name: 'X', last_name: 'Y' }).expect(403);
  await agent.post('/account/profile').set('Sec-Fetch-Site', 'cross-site').type('form').send({ _csrf: token, first_name: 'X', last_name: 'Y' }).expect(403);
});

test('sign-up bot trap: honeypot submissions create no account', async () => {
  const agent = request.agent(app);
  const token = await csrf(agent, '/register');
  const res = await agent.post('/register').type('form').send({
    _csrf: token, first_name: 'Bot', last_name: 'Bot', email: 'bot@example.com', password: PASSWORD, confirm: PASSWORD, terms: 'on', website: 'http://spam',
  });
  assert.equal(res.status, 200);
  assert.match(res.text, /Check your email/);
  assert.equal(await one(`SELECT id FROM users WHERE email = 'bot@example.com'`), null);
});

test('sessions: absolute lifetime and security alerts', async () => {
  const agent = await learner('session2@example.com');
  await query(`UPDATE session SET sess = jsonb_set(sess::jsonb, '{createdAt}', to_jsonb((extract(epoch FROM now() - interval '8 days') * 1000)::bigint))::json WHERE sess->>'userId' = (SELECT id::text FROM users WHERE email = 'session2@example.com')`);
  const res = await agent.get('/dashboard');
  assert.equal(res.status, 302, 'session older than 7 days is ended');

  // Password changes trigger an email alert.
  const fresh = request.agent(app);
  let token = await csrf(fresh, '/login');
  await fresh.post('/login').type('form').send({ _csrf: token, email: 'session2@example.com', password: PASSWORD }).expect(302);
  token = await csrf(fresh, '/account');
  await fresh.post('/account/password').type('form').send({ _csrf: token, current: PASSWORD, password: 'another long passphrase here', confirm: 'another long passphrase here' }).expect(302);
  assert.match(lastMailTo('session2@example.com').subject, /Security alert: your password was changed/);
});

test('identity reviewers see the review queue and evidence — nothing else', async () => {
  await learner('reviewed@example.com');
  const attemptId = await pendingAttemptWithEvidence('reviewed@example.com');
  const { agent: reviewer, id: reviewerId } = await staff('reviewer@example.com', 'reviewer');

  for (const path of ['/admin/users', '/admin/courses', '/admin/certificates', '/admin/audit', '/admin/certificates.csv']) {
    await reviewer.get(path).expect(404);
  }
  assert.equal((await reviewer.get('/admin')).headers.location, '/admin/attempts?filter=review');
  const page = await reviewer.get(`/admin/attempts/${attemptId}`).expect(200);
  assert.match(page.text, /Approve and issue certificate/);
  assert.ok(!page.text.includes('/admin/users/'), 'no links into learner management');
  assert.ok(!page.text.includes('Void this attempt'));

  // Every evidence view is logged (and throttled so a page load doesn't flood the log).
  const media = await many('SELECT id, kind FROM proctor_media WHERE attempt_id = $1', [attemptId]);
  for (const m of media) await reviewer.get(`/admin/media/${m.id}`).expect(200);
  await reviewer.get(`/admin/media/${media[0].id}`).expect(200);
  const logged = await many(`SELECT meta->>'kind' AS kind FROM audit_log WHERE actor_id = $1 AND action = 'staff.evidence_viewed'`, [reviewerId]);
  assert.equal(logged.length, 3);

  // Reviewers can decide, but can't delete evidence or void outside the review flow.
  let token = await csrf(reviewer, `/admin/attempts/${attemptId}`);
  await reviewer.post(`/admin/attempts/${attemptId}/purge-evidence`).type('form').send({ _csrf: token }).expect(404);
  await reviewer.post(`/admin/attempts/${attemptId}/review`).type('form').send({ _csrf: token, decision: 'approve', note: 'ok' }).expect(302);
  assert.ok(await one('SELECT id FROM certificates WHERE attempt_id = $1', [attemptId]));

  // Admins can delete evidence once decided.
  const { agent: admin } = await staff('admin2@example.com', 'admin');
  token = await csrf(admin, `/admin/attempts/${attemptId}`);
  await admin.post(`/admin/attempts/${attemptId}/purge-evidence`).type('form').send({ _csrf: token }).expect(302);
  assert.equal((await one('SELECT count(*)::int AS n FROM proctor_media WHERE attempt_id = $1', [attemptId])).n, 0);
  assert.ok((await one('SELECT evidence_purged_at FROM exam_attempts WHERE id = $1', [attemptId])).evidence_purged_at);

  // Changing someone's role signs them out everywhere and emails them.
  const target = await one(`SELECT id FROM users WHERE email = 'reviewer@example.com'`);
  token = await csrf(admin, `/admin/users/${target.id}`);
  await admin.post(`/admin/users/${target.id}/action`).type('form').send({ _csrf: token, action: 'make_student' }).expect(302);
  assert.notEqual((await reviewer.get(`/admin/attempts/${attemptId}`)).status, 200);
  assert.match(lastMailTo('reviewer@example.com').subject, /access changed/);
});

test('evidence retention: deleted after a decision, and never kept past the maximum', async () => {
  await learner('retention@example.com');
  const decided = await pendingAttemptWithEvidence('retention@example.com');
  await query(`UPDATE exam_attempts SET review_status = 'approved', reviewed_at = now() - interval '31 days' WHERE id = $1`, [decided]);
  await query(`UPDATE exam_attempts SET review_status = 'rejected', status = 'voided' WHERE user_id = (SELECT id FROM users WHERE email = 'retention@example.com') AND id <> $1`, [decided]);
  const stale = await pendingAttemptWithEvidence('retention@example.com');
  await query(`UPDATE exam_attempts SET review_status = 'pending' WHERE id = $1`, [stale]);
  await query(`UPDATE proctor_media SET created_at = now() - interval '91 days' WHERE attempt_id = $1`, [stale]);
  const recent = await pendingAttemptWithEvidence('retention@example.com');
  await query(`UPDATE exam_attempts SET status = 'voided', review_status = 'rejected' WHERE id = $1`, [stale]);
  await query(`UPDATE exam_attempts SET status = 'voided', review_status = 'rejected', reviewed_at = now() WHERE id = $1`, [recent]);

  await purgeProctorMedia();
  const left = async (id) => (await one('SELECT count(*)::int AS n FROM proctor_media WHERE attempt_id = $1', [id])).n;
  assert.equal(await left(decided), 0, 'decided 31 days ago');
  assert.equal(await left(stale), 0, 'older than the maximum');
  assert.equal(await left(recent), 3, 'recent decision is kept');
});

test('privacy: data export and account deletion', async () => {
  const agent = await learner('leaving@example.com');
  const user = await one(`SELECT id FROM users WHERE email = 'leaving@example.com'`);
  const attemptId = await pendingAttemptWithEvidence('leaving@example.com');
  await query(`UPDATE exam_attempts SET review_status = 'approved', reviewed_at = now(), ip = '203.0.113.9' WHERE id = $1`, [attemptId]);
  const cert = await one(
    `INSERT INTO certificates (code, user_id, course_id, attempt_id, full_name, course_title, score_percent, expires_at)
     SELECT 'HV-2026-AAAA-BBBB', $1, course_id, id, 'Sam Rivera', 'Food Handler Certification', 90, now() + interval '5 years'
       FROM exam_attempts WHERE id = $2 RETURNING code`,
    [user.id, attemptId],
  );

  const exp = await agent.get('/account/export').expect(200);
  assert.match(exp.headers['content-disposition'], /attachment/);
  const data = JSON.parse(exp.text);
  assert.equal(data.profile.email, 'leaving@example.com');
  assert.equal(data.certificates[0].code, cert.code);
  assert.equal(data.exam_attempts[0].proctoring_files.length, 3);

  let token = await csrf(agent, '/account');
  await agent.post('/account/delete').type('form').send({ _csrf: token, confirm: 'DELETE', del_password: 'wrong password' }).expect(302);
  assert.equal((await one('SELECT deleted_at FROM users WHERE id = $1', [user.id])).deleted_at, null);
  token = await csrf(agent, '/account');
  const res = await agent.post('/account/delete').type('form').send({ _csrf: token, confirm: 'DELETE', del_password: PASSWORD }).expect(302);
  assert.equal(res.headers.location, '/?deleted=1');

  const after = await one('SELECT * FROM users WHERE id = $1', [user.id]);
  assert.ok(after.deleted_at);
  assert.notEqual(after.email, 'leaving@example.com');
  assert.equal((await one('SELECT count(*)::int AS n FROM proctor_media WHERE attempt_id = $1', [attemptId])).n, 0);
  assert.equal((await one('SELECT ip FROM exam_attempts WHERE id = $1', [attemptId])).ip, null);
  // The certificate stays verifiable.
  const verify = await request(app).get(`/verify/${cert.code}`).expect(200);
  assert.match(verify.text, /Valid certificate/);
  // The old credentials no longer work, and the email can register again.
  const again = request.agent(app);
  token = await csrf(again, '/login');
  await again.post('/login').type('form').send({ _csrf: token, email: 'leaving@example.com', password: PASSWORD }).expect(401);
  await learner('leaving@example.com');
});

test('certificate expiry reminders are sent once', async () => {
  await learner('renew@example.com');
  const u = await one(`SELECT id FROM users WHERE email = 'renew@example.com'`);
  const c = await one('SELECT id, title FROM courses LIMIT 1');
  await query(
    `INSERT INTO certificates (code, user_id, course_id, full_name, course_title, score_percent, expires_at)
     VALUES ('HV-2026-RENW-0001', $1, $2, 'Sam Rivera', $3, 88, now() + interval '30 days')`,
    [u.id, c.id, c.title],
  );
  assert.equal(await sendExpiryReminders(), 1);
  assert.match(lastMailTo('renew@example.com').subject, /expires soon/);
  assert.equal(await sendExpiryReminders(), 0);
});

test('site essentials: robots, sitemap, security.txt, terms, social metadata', async () => {
  const robots = await request(app).get('/robots.txt').expect(200);
  assert.match(robots.text, /Disallow: \/admin/);
  assert.match(robots.text, /Sitemap: /);
  const sitemap = await request(app).get('/sitemap.xml').expect(200);
  assert.match(sitemap.text, /<urlset/);
  const sec = await request(app).get('/.well-known/security.txt').expect(200);
  assert.match(sec.text, /^Contact: mailto:/m);
  assert.match(sec.text, /^Expires: /m);
  await request(app).get('/terms').expect(200);
  const home = await request(app).get('/').expect(200);
  assert.match(home.text, /property="og:image"/);
  assert.match(home.text, /"@type":"Course"/);
  await request(app).get('/site.webmanifest').expect(200);
  await request(app).get('/img/og-card.png').expect(200);
});
