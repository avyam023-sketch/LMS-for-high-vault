import { Router } from 'express';
import Stripe from 'stripe';
import { one, query } from '../db/pool.js';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { requireAuth } from '../lib/auth.js';
import { enrolmentEmail } from '../lib/notify.js';
import { flash } from '../lib/view-helpers.js';

const router = Router();
const stripe = config.paymentsEnabled ? new Stripe(config.STRIPE_SECRET_KEY) : null;

router.post('/enroll/:slug', requireAuth, async (req, res) => {
  const course = await one('SELECT * FROM courses WHERE slug = $1 AND is_published', [req.params.slug]);
  if (!course) return res.redirect('/');
  const existing = await one('SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2', [req.user.id, course.id]);
  if (existing) return res.redirect(`/learn/${course.slug}`);

  // A paid course must never enrol for free just because payments aren't configured yet.
  if (course.price_cents > 0 && !stripe) {
    console.error('[payments] paid course but STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are not set');
    flash(req, 'warn', `Online payment isn’t available right now. Please try again later or email ${config.SUPPORT_EMAIL}.`);
    return res.redirect(`/course/${course.slug}#pricing`);
  }

  // Paid course: send the learner to Stripe Checkout.
  if (course.price_cents > 0) {
    const checkout = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: req.user.email,
      client_reference_id: req.user.id,
      line_items: [
        {
          quantity: 1,
          price_data: { currency: course.currency, unit_amount: course.price_cents, product_data: { name: course.title } },
        },
      ],
      metadata: { user_id: req.user.id, course_id: course.id },
      success_url: `${config.appUrl}/payments/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.appUrl}/`,
    });
    await query(
      'INSERT INTO payments (user_id, course_id, stripe_session_id, amount_cents, currency) VALUES ($1, $2, $3, $4, $5)',
      [req.user.id, course.id, checkout.id, course.price_cents, course.currency],
    );
    return res.redirect(303, checkout.url);
  }

  await query('INSERT INTO enrollments (user_id, course_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, course.id]);
  await audit(req, 'enrollment.created', { entity: 'course', entityId: course.id });
  await enrolmentEmail(req.user.id, course.id);
  flash(req, 'success', `You're enrolled in ${course.title}. Start with the first lesson below.`);
  res.redirect(`/learn/${course.slug}`);
});

router.get('/payments/success', requireAuth, async (req, res) => {
  const payment = await one(
    `SELECT p.status, c.slug FROM payments p JOIN courses c ON c.id = p.course_id WHERE p.stripe_session_id = $1 AND p.user_id = $2`,
    [String(req.query.session_id ?? ''), req.user.id],
  );
  if (!payment) return res.redirect('/dashboard');
  if (payment.status === 'paid') return res.redirect(`/learn/${payment.slug}`);
  res.render('learn/payment-pending', { title: 'Confirming payment', slug: payment.slug, sessionId: String(req.query.session_id) });
});

/** Stripe webhook — the only source of truth for a completed payment. */
export async function stripeWebhook(req, res) {
  if (!stripe) return res.status(404).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), config.STRIPE_WEBHOOK_SECRET);
  } catch {
    return res.status(400).send('Invalid signature');
  }
  if (event.type === 'checkout.session.completed' && event.data.object.payment_status === 'paid') {
    const s = event.data.object;
    const payment = await one(
      `UPDATE payments SET status = 'paid', paid_at = now() WHERE stripe_session_id = $1 AND status <> 'paid' RETURNING *`,
      [s.id],
    );
    if (payment) {
      await query(
        `INSERT INTO enrollments (user_id, course_id, source, payment_ref) VALUES ($1, $2, 'payment', $3) ON CONFLICT DO NOTHING`,
        [payment.user_id, payment.course_id, s.payment_intent ?? s.id],
      );
      await audit(null, 'payment.completed', { entity: 'payment', entityId: payment.id, actorId: payment.user_id, meta: { amount: payment.amount_cents, reference: payment.reference } });
      await enrolmentEmail(payment.user_id, payment.course_id, payment.id);
    }
  }
  res.json({ received: true });
}

export default router;
