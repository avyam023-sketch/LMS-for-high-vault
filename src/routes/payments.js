import { Router } from 'express';
import Stripe from 'stripe';
import { one, query, tx } from '../db/pool.js';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { requireAuth } from '../lib/auth.js';
import { enrolmentEmail, refundEmail } from '../lib/notify.js';
import { flash } from '../lib/view-helpers.js';

const router = Router();
let stripe = config.STRIPE_SECRET_KEY ? new Stripe(config.STRIPE_SECRET_KEY) : null;
/** Tests replace the Stripe client with a fake. */
export const setStripeForTests = (fake) => { stripe = fake; };

router.post('/enroll/:slug', requireAuth, async (req, res) => {
  const course = await one('SELECT * FROM courses WHERE slug = $1 AND is_published', [req.params.slug]);
  if (!course) return res.redirect('/');
  const existing = await one('SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2', [req.user.id, course.id]);
  if (existing) return res.redirect(`/learn/${course.slug}`);

  // A paid course must never enrol for free just because payments aren't configured yet.
  if (course.price_cents > 0 && !stripe) {
    console.error('[payments] paid course but STRIPE_SECRET_KEY is not set');
    flash(req, 'warn', `Online payment isn’t available right now. Please try again later or email ${config.SUPPORT_EMAIL}.`);
    return res.redirect(`/course/${course.slug}#pricing`);
  }

  // Paid course: send the learner to Stripe Checkout.
  if (course.price_cents > 0) {
    let checkout;
    try {
      checkout = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: req.user.email,
        client_reference_id: req.user.id,
        line_items: [
          {
            quantity: 1,
            price_data: { currency: course.currency, unit_amount: course.price_cents, product_data: { name: course.title } },
          },
        ],
        ...(config.STRIPE_AUTOMATIC_TAX ? { automatic_tax: { enabled: true }, billing_address_collection: 'required' } : {}),
        metadata: { user_id: req.user.id, course_id: course.id },
        success_url: `${config.appUrl}/payments/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${config.appUrl}/course/${course.slug}#pricing`,
      }, {
        // A double-click or a second tab within a few minutes gets the same checkout page back, not a
        // second one the learner could also pay.
        idempotencyKey: `enroll:${req.user.id}:${course.id}:${course.price_cents}:${Math.floor(Date.now() / (10 * 60_000))}`,
      });
    } catch (err) {
      console.error('[payments] could not start checkout:', err.message);
      flash(req, 'warn', `We couldn’t open the payment page. Please try again, or email ${config.SUPPORT_EMAIL}.`);
      return res.redirect(`/course/${course.slug}#pricing`);
    }
    await query(
      `INSERT INTO payments (user_id, course_id, stripe_session_id, amount_cents, currency) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (stripe_session_id) DO NOTHING`,
      [req.user.id, course.id, checkout.id, course.price_cents, course.currency],
    );
    return res.redirect(303, checkout.url);
  }

  const added = await one('INSERT INTO enrollments (user_id, course_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id', [req.user.id, course.id]);
  await audit(req, 'enrollment.created', { entity: 'course', entityId: course.id });
  if (added) await enrolmentEmail(req.user.id, course.id);
  flash(req, 'success', `You're enrolled in ${course.title}. Start with the first lesson below.`);
  res.redirect(`/learn/${course.slug}`);
});

/**
 * Marks a Stripe Checkout session as paid and enrols the learner, once. Called from the page the
 * learner returns to and from the webhook, so either one is enough and neither can double-enrol.
 * The amount, currency and buyer are checked against what we asked Stripe to charge.
 */
export async function fulfilCheckout(session) {
  if (session?.mode !== 'payment' || session.payment_status !== 'paid') return null;
  const result = await tx(async (db) => {
    const { rows } = await db.query('SELECT * FROM payments WHERE stripe_session_id = $1 FOR UPDATE', [session.id]);
    const payment = rows[0];
    if (!payment) return null;
    if (payment.status === 'paid' || payment.status === 'refunded') return { payment, fresh: false };
    const subtotal = session.amount_subtotal ?? session.amount_total;
    if (subtotal !== payment.amount_cents || String(session.currency).toLowerCase() !== payment.currency
      || (session.metadata?.user_id && session.metadata.user_id !== payment.user_id)) {
      console.error(`[payments] session ${session.id} does not match payment ${payment.id}; not fulfilled`);
      return null;
    }
    const { rows: updated } = await db.query(
      `UPDATE payments SET status = 'paid', paid_at = now(), stripe_payment_intent = $2, amount_paid_cents = $3 WHERE id = $1 RETURNING *`,
      [payment.id, typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null, session.amount_total ?? subtotal],
    );
    await db.query(
      `INSERT INTO enrollments (user_id, course_id, source, payment_ref) VALUES ($1, $2, 'payment', $3) ON CONFLICT DO NOTHING`,
      [payment.user_id, payment.course_id, updated[0].reference],
    );
    return { payment: updated[0], fresh: true };
  });
  if (result?.fresh) {
    await audit(null, 'payment.completed', {
      entity: 'payment', entityId: result.payment.id, actorId: result.payment.user_id,
      meta: { amount: result.payment.amount_paid_cents, reference: result.payment.reference },
    });
    await enrolmentEmail(result.payment.user_id, result.payment.course_id, result.payment.id);
  }
  return result?.payment ?? null;
}

/** A full refund in Stripe ends access to the course, as the refund policy says. */
export async function recordRefund(charge) {
  const intent = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  if (!intent || !charge.refunded) return null; // partial refunds keep access
  const payment = await tx(async (db) => {
    const { rows } = await db.query(
      `UPDATE payments SET status = 'refunded', refunded_at = now() WHERE stripe_payment_intent = $1 AND status = 'paid' RETURNING *`,
      [intent],
    );
    if (rows[0]) await db.query(`DELETE FROM enrollments WHERE user_id = $1 AND course_id = $2 AND source = 'payment'`, [rows[0].user_id, rows[0].course_id]);
    return rows[0] ?? null;
  });
  if (payment) {
    await audit(null, 'payment.refunded', { entity: 'payment', entityId: payment.id, actorId: payment.user_id, meta: { reference: payment.reference } });
    await refundEmail(payment.id);
  }
  return payment;
}

router.get('/payments/success', requireAuth, async (req, res) => {
  const sessionId = String(req.query.session_id ?? '').slice(0, 200);
  let payment = await one(
    `SELECT p.*, c.slug, c.title FROM payments p JOIN courses c ON c.id = p.course_id WHERE p.stripe_session_id = $1 AND p.user_id = $2`,
    [sessionId, req.user.id],
  );
  if (!payment) return res.redirect('/dashboard');
  // Ask Stripe directly, so the learner isn't left waiting for the webhook.
  if (payment.status === 'pending' && stripe) {
    try {
      const done = await fulfilCheckout(await stripe.checkout.sessions.retrieve(sessionId));
      if (done) payment = { ...payment, ...done };
    } catch (err) {
      console.error('[payments] could not check the checkout session', err.message);
    }
  }
  if (payment.status === 'paid') {
    flash(req, 'success', `Payment received (${payment.reference}). You're enrolled in ${payment.title}. Start with Module 1.`);
    return res.redirect(`/learn/${payment.slug}`);
  }
  res.render('learn/payment-pending', { title: 'Confirming payment', slug: payment.slug, sessionId });
});

/** Stripe webhook: confirms payments (including slow payment methods) and records refunds. */
export async function stripeWebhook(req, res) {
  if (!stripe || !config.STRIPE_WEBHOOK_SECRET) return res.status(404).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), config.STRIPE_WEBHOOK_SECRET);
  } catch {
    return res.status(400).send('Invalid signature');
  }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    await fulfilCheckout(event.data.object);
  } else if (event.type === 'checkout.session.async_payment_failed' || event.type === 'checkout.session.expired') {
    await query(`UPDATE payments SET status = 'failed' WHERE stripe_session_id = $1 AND status = 'pending'`, [event.data.object.id]);
  } else if (event.type === 'charge.refunded') {
    await recordRefund(event.data.object);
  }
  res.json({ received: true });
}

export default router;
