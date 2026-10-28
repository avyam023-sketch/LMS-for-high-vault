import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { pool, query, one } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { outbox } from '../src/lib/mailer.js';
import { setStripeForTests, recordRefund } from '../src/routes/payments.js';

const SLUG = 'food-handler-certification';
let app;
let course;

// A stand-in for the Stripe client: remembers the checkout sessions it "created" so the
// success page and the webhook can look them up, and lets a test mark one as paid.
const sessions = new Map();
let created = 0;
const fakeStripe = {
  checkout: {
    sessions: {
      async create(params) {
        const id = `cs_test_${++created}`;
        const s = {
          id, mode: params.mode, url: `https://checkout.stripe.com/c/pay/${id}`, payment_status: 'unpaid',
          amount_subtotal: params.line_items[0].price_data.unit_amount, amount_total: params.line_items[0].price_data.unit_amount,
          currency: params.line_items[0].price_data.currency, metadata: params.metadata, payment_intent: null, params,
        };
        sessions.set(id, s);
        return s;
      },
      async retrieve(id) {
        const s = sessions.get(id);
        if (!s) throw new Error('No such checkout session');
        return s;
      },
    },
  },
  webhooks: {
    constructEvent(body, signature) {
      if (signature !== 'good-signature') throw new Error('bad signature');
      return JSON.parse(body.toString());
    },
  },
};
const pay = (id, extra = {}) => Object.assign(sessions.get(id), { payment_status: 'paid', payment_intent: `pi_${id}`, ...extra });

const csrfFrom = (html) => html.match(/name="_csrf" value="([^"]+)"/)?.[1];
async function csrf(agent, url) {
  const token = csrfFrom((await agent.get(url)).text);
  assert.ok(token, `no CSRF token on ${url}`);
  return token;
}

async function learner(email) {
  const agent = request.agent(app);
  const password = 'correct horse battery staple';
  const token = await csrf(agent, '/register');
  await agent.post('/register').type('form')
    .send({ _csrf: token, first_name: 'Sam', last_name: 'Rivera', email, password, confirm: password, terms: 'on' }).expect(302);
  const link = [...outbox].reverse().find((m) => m.to === email).text.match(/\/verify-email\/([\w-]+)/)[1];
  await agent.get(`/verify-email/${link}`).expect(302);
  const user = await one('SELECT id FROM users WHERE email = $1', [email]);
  return { agent, user };
}

async function checkout(agent) {
  const token = await csrf(agent, `/course/${SLUG}`);
  const res = await agent.post(`/enroll/${SLUG}`).type('form').send({ _csrf: token }).expect(303);
  assert.match(res.headers.location, /^https:\/\/checkout\.stripe\.com\//);
  return res.headers.location.split('/').pop();
}

const enrolment = (userId) => one('SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2', [userId, course.id]);
const webhook = (event, signature = 'good-signature') =>
  request(app).post('/webhooks/stripe').set('stripe-signature', signature).set('Content-Type', 'application/json').send(JSON.stringify(event));

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate({ log: () => {} });
  await seed({ log: () => {} });
  await query(`UPDATE courses SET price_cents = 8900, currency = 'usd'`);
  setStripeForTests(fakeStripe);
  config.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  app = createApp();
  course = await one('SELECT * FROM courses WHERE slug = $1', [SLUG]);
});

after(() => pool.end());

test('checkout: paying and returning enrols the learner once, with a payment reference', async () => {
  const { agent, user } = await learner('buyer@example.com');
  const id = await checkout(agent);
  const payment = await one('SELECT * FROM payments WHERE stripe_session_id = $1', [id]);
  assert.equal(payment.status, 'pending');
  assert.match(payment.reference, /^HV-P-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  assert.equal(sessions.get(id).params.cancel_url.endsWith(`/course/${SLUG}#pricing`), true);

  // Back from Stripe before paying: still waiting, not enrolled.
  let res = await agent.get(`/payments/success?session_id=${id}`).expect(200);
  assert.match(res.text, /Confirming your payment/);
  assert.equal(await enrolment(user.id), null);

  // Paid: the return page confirms it with Stripe directly, without waiting for the webhook.
  pay(id);
  res = await agent.get(`/payments/success?session_id=${id}`).expect(302);
  assert.equal(res.headers.location, `/learn/${SLUG}`);
  const paid = await one('SELECT * FROM payments WHERE id = $1', [payment.id]);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.stripe_payment_intent, `pi_${id}`);
  assert.equal(paid.amount_paid_cents, 8900);
  const e = await enrolment(user.id);
  assert.equal(e.source, 'payment');
  assert.equal(e.payment_ref, payment.reference);
  const mail = [...outbox].reverse().find((m) => m.to === 'buyer@example.com');
  assert.match(mail.subject, /Payment received/);
  assert.match(mail.text, new RegExp(payment.reference));

  // The webhook arriving afterwards changes nothing and sends no second email.
  const before = outbox.length;
  await webhook({ type: 'checkout.session.completed', data: { object: sessions.get(id) } }).expect(200);
  assert.equal(outbox.length, before);
  assert.equal((await one('SELECT count(*)::int AS n FROM enrollments WHERE user_id = $1', [user.id])).n, 1);
  assert.ok(await one(`SELECT id FROM audit_log WHERE action = 'payment.completed' AND entity_id = $1`, [payment.id]));

  // Someone else can't use the session ID to see or claim the payment.
  const other = await learner('nosy@example.com');
  res = await other.agent.get(`/payments/success?session_id=${id}`).expect(302);
  assert.equal(res.headers.location, '/dashboard');
});

test('webhook: confirms payment on its own; rejects bad signatures and mismatched amounts', async () => {
  const { agent, user } = await learner('webhook@example.com');
  const id = await checkout(agent);
  await webhook({ type: 'checkout.session.completed', data: { object: pay(id) } }, 'forged').expect(400);
  assert.equal(await enrolment(user.id), null, 'a forged event does nothing');
  await webhook({ type: 'checkout.session.completed', data: { object: sessions.get(id) } }).expect(200);
  assert.ok(await enrolment(user.id));

  // A session whose amount differs from what we asked for is never fulfilled.
  const cheap = await learner('cheap@example.com');
  const id2 = await checkout(cheap.agent);
  pay(id2, { amount_subtotal: 100, amount_total: 100 });
  await cheap.agent.get(`/payments/success?session_id=${id2}`).expect(200);
  await webhook({ type: 'checkout.session.completed', data: { object: sessions.get(id2) } }).expect(200);
  assert.equal(await enrolment(cheap.user.id), null);
  assert.equal((await one('SELECT status FROM payments WHERE stripe_session_id = $1', [id2])).status, 'pending');

  // An abandoned checkout is marked failed.
  const gone = await learner('gone@example.com');
  const id3 = await checkout(gone.agent);
  await webhook({ type: 'checkout.session.expired', data: { object: sessions.get(id3) } }).expect(200);
  assert.equal((await one('SELECT status FROM payments WHERE stripe_session_id = $1', [id3])).status, 'failed');
});

test('refunds: a full refund ends access; a partial one does not', async () => {
  const { agent, user } = await learner('refund@example.com');
  const id = await checkout(agent);
  pay(id);
  await agent.get(`/payments/success?session_id=${id}`).expect(302);
  assert.ok(await enrolment(user.id));

  assert.equal(await recordRefund({ payment_intent: `pi_${id}`, refunded: false }), null, 'partial refund keeps access');
  assert.ok(await enrolment(user.id));

  await webhook({ type: 'charge.refunded', data: { object: { payment_intent: `pi_${id}`, refunded: true } } }).expect(200);
  const p = await one('SELECT * FROM payments WHERE stripe_session_id = $1', [id]);
  assert.equal(p.status, 'refunded');
  assert.ok(p.refunded_at);
  assert.equal(await enrolment(user.id), null);
  const mail = [...outbox].reverse().find((m) => m.to === 'refund@example.com');
  assert.match(mail.subject, /refund/i);
  assert.match(mail.text, new RegExp(p.reference));

  // A late "completed" event can't re-enrol a refunded payment.
  await webhook({ type: 'checkout.session.completed', data: { object: sessions.get(id) } }).expect(200);
  assert.equal(await enrolment(user.id), null);

  // They can buy again later.
  const again = await checkout(agent);
  assert.notEqual(again, id);
});

test('a Stripe test key shows the test card on the pricing card', async () => {
  config.paymentsTestMode = true;
  try {
    const res = await request(app).get(`/course/${SLUG}`).expect(200);
    assert.match(res.text, /4242 4242 4242 4242/);
  } finally {
    config.paymentsTestMode = false;
  }
  const res = await request(app).get(`/course/${SLUG}`).expect(200);
  assert.doesNotMatch(res.text, /4242 4242/);
});
