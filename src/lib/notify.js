// Every automatic email the platform sends, in one place so wording and branding stay consistent.
// Each one carries the reference codes a learner would quote to support (learner ID, exam reference,
// certificate or payment number). Sending never throws; see mailer.js.
import { config } from '../config.js';
import { many, one } from '../db/pool.js';
import { sendMail } from './mailer.js';
import { money } from './view-helpers.js';

const subject = (s) => `${s} — THVFoodSafe`;
const TZ = 'America/Toronto';
const longDate = (d) => new Date(d).toLocaleDateString('en-CA', { dateStyle: 'long', timeZone: TZ });
const dateTime = (d) => new Date(d).toLocaleString('en-CA', { dateStyle: 'long', timeStyle: 'short', timeZone: TZ });
const url = (path) => `${config.appUrl}${path}`;

// ---------- Account ----------

export function verificationEmail(user, link, code) {
  return sendMail({
    to: user.email,
    subject: subject(`${code} is your confirmation code`),
    heading: `Welcome, ${user.first_name}`,
    body: ['Enter this code on the confirmation page to start your course. It expires in 1 hour.'],
    code: `${code.slice(0, 3)} ${code.slice(3)}`,
    action: { label: 'Or confirm with one click', url: link },
    footer: 'If you didn’t create an account, ignore this email and nothing will happen.',
    category: 'verify-email',
  });
}

export function accountExistsEmail(email) {
  return sendMail({
    to: email,
    subject: subject('Sign-in help'),
    heading: 'You already have an account',
    body: ['Someone (hopefully you) tried to register with this email. If you forgot your password, reset it below.'],
    action: { label: 'Reset password', url: url('/forgot-password') },
    footer: 'If this wasn’t you, you can ignore this email. Your account is unchanged.',
    category: 'account-exists',
  });
}

export function passwordResetEmail(user, link) {
  return sendMail({
    to: user.email,
    subject: subject('Reset your password'),
    heading: 'Reset your password',
    body: ['Use the button below to choose a new password. The link expires in 1 hour.', 'If you didn’t ask for this, ignore this email.'],
    action: { label: 'Choose a new password', url: link },
    category: 'password-reset',
  });
}

/** Sent once the email address is confirmed (or straight after sign-up when confirmation is off). */
export async function welcomeEmail(userId) {
  const u = await one('SELECT id, email, first_name, reference FROM users WHERE id = $1', [userId]);
  if (!u) return false;
  const course = await one('SELECT title, slug FROM courses WHERE is_published ORDER BY created_at LIMIT 1');
  return sendMail({
    to: u.email,
    subject: subject('Welcome — your account is ready'),
    heading: `You’re all set, ${u.first_name}`,
    body: [
      'Your account is confirmed. Work through the ten modules at your own pace: each chapter is followed by a short quiz, and the final exam unlocks once every module is complete.',
      'Keep your learner ID handy. Quote it whenever you contact us.',
    ],
    details: [['Learner ID', u.reference]],
    action: { label: course ? `Start ${course.title}` : 'Go to my learning', url: url(course ? `/course/${course.slug}` : '/dashboard') },
    idempotencyKey: `welcome/${u.id}`,
    category: 'welcome',
  });
}

export async function securityNotice(user, change, ip) {
  return sendMail({
    to: user.email,
    subject: subject(`Security alert: ${change.toLowerCase()}`),
    heading: change,
    body: [
      `This happened on ${dateTime(new Date())} (Toronto time)${ip ? ` from IP address ${ip}` : ''}.`,
      'If this was you, no action is needed.',
      `If it wasn’t, reset your password now and contact ${config.SUPPORT_EMAIL}.`,
    ],
    action: { label: 'Reset your password', url: url('/forgot-password') },
    category: 'security',
  });
}

export function roleChangedEmail(target, role) {
  return sendMail({
    to: target.email,
    subject: subject('Your account access changed'),
    heading: `Hi ${target.first_name}`,
    body: [
      role === 'student' ? 'Your staff access has been removed.' : `You now have ${role === 'admin' ? 'administrator' : 'identity reviewer'} access.`,
      role === 'student' ? '' : 'Sign in again. You’ll be asked to set up two-step verification if you haven’t already.',
      `If you didn’t expect this change, contact ${config.SUPPORT_EMAIL} right away.`,
    ].filter(Boolean),
    action: { label: 'Sign in', url: url('/login') },
    category: 'security',
  });
}

export function accountDeletedEmail(email) {
  return sendMail({
    to: email,
    subject: subject('Your account has been deleted'),
    heading: 'Account deleted',
    body: [
      'Your account and personal data have been deleted.',
      'Any certificate already issued remains verifiable by its number until it expires, as described in our privacy policy.',
    ],
    footer: `If you didn’t ask for this, contact ${config.SUPPORT_EMAIL} right away.`,
    category: 'account-deleted',
  });
}

// ---------- Enrolment and payment ----------

export async function enrolmentEmail(userId, courseId, paymentId = null) {
  const u = await one('SELECT email, first_name, reference FROM users WHERE id = $1', [userId]);
  const c = await one('SELECT title, slug FROM courses WHERE id = $1', [courseId]);
  if (!u || !c) return false;
  const p = paymentId ? await one('SELECT reference, amount_cents, currency, paid_at FROM payments WHERE id = $1', [paymentId]) : null;
  return sendMail({
    to: u.email,
    subject: subject(p ? 'Payment received — you’re enrolled' : 'You’re enrolled'),
    heading: `You’re enrolled in ${c.title}`,
    body: [
      p ? 'Thank you, your payment was successful. Your receipt from our payment provider arrives separately.' : 'Your enrolment is confirmed.',
      'Start with Module 1 whenever you’re ready. Your progress is saved as you go.',
    ],
    details: [
      ['Learner ID', u.reference],
      ...(p ? [['Payment reference', p.reference], ['Amount', money(p.amount_cents, p.currency)], ['Paid', dateTime(p.paid_at ?? new Date())]] : []),
    ],
    action: { label: 'Start Module 1', url: url(`/learn/${c.slug}`) },
    idempotencyKey: `enrolled/${userId}/${courseId}`,
    category: 'enrolment',
  });
}

export async function refundEmail(paymentId) {
  const p = await one(
    `SELECT p.reference, p.amount_cents, p.amount_paid_cents, p.currency, p.user_id, u.email, u.first_name, u.reference AS learner_ref, c.title
       FROM payments p JOIN users u ON u.id = p.user_id JOIN courses c ON c.id = p.course_id WHERE p.id = $1`,
    [paymentId],
  );
  if (!p) return false;
  return sendMail({
    to: p.email,
    subject: subject('Your refund is on its way'),
    heading: `Hi ${p.first_name}, your payment has been refunded`,
    body: [
      `We’ve refunded your payment for ${p.title}. Banks usually take 5 to 10 business days to show it on your statement.`,
      'Your access to the course has ended. If you’d like to come back later, you can enrol again at any time.',
    ],
    details: [
      ['Learner ID', p.learner_ref],
      ['Payment reference', p.reference],
      ['Refunded', money(p.amount_paid_cents ?? p.amount_cents, p.currency)],
    ],
    footer: `Questions? Email ${config.SUPPORT_EMAIL} and quote your payment reference.`,
    idempotencyKey: `refund/${paymentId}`,
    category: 'refund',
  });
}

export async function extraAttemptEmail(userId, courseId) {
  const u = await one('SELECT email, first_name, reference FROM users WHERE id = $1', [userId]);
  const c = await one('SELECT title, slug FROM courses WHERE id = $1', [courseId]);
  if (!u || !c) return false;
  return sendMail({
    to: u.email,
    subject: subject('You can take the exam again'),
    heading: `Hi ${u.first_name}, another attempt is ready`,
    body: [`We’ve added an extra attempt at the ${c.title} final exam to your account.`, 'Make sure you’re in a quiet room with your ID before you start.'],
    details: [['Learner ID', u.reference]],
    action: { label: 'Go to the final exam', url: url(`/learn/${c.slug}/exam`) },
    category: 'extra-attempt',
  });
}

// ---------- Exam ----------

const attemptQuery = `
  SELECT a.*, u.email, u.first_name, u.reference AS learner_ref, c.title AS course_title, c.slug, c.pass_mark,
         c.max_attempts, c.attempt_cooldown_minutes, coalesce(e.extra_attempts, 0) AS extra_attempts,
         (SELECT count(*) FROM exam_attempts x WHERE x.user_id = a.user_id AND x.course_id = a.course_id AND x.status <> 'checkin')::int AS used
    FROM exam_attempts a JOIN users u ON u.id = a.user_id JOIN courses c ON c.id = a.course_id
    LEFT JOIN enrollments e ON e.user_id = a.user_id AND e.course_id = a.course_id
   WHERE a.id = $1`;

/** Sent when an exam is submitted, by the learner, the timer or the integrity rules. */
export async function examResultEmail(attemptId) {
  const a = await one(attemptQuery, [attemptId]);
  if (!a || a.status !== 'submitted') return false;
  const cert = a.passed ? await one('SELECT code, expires_at FROM certificates WHERE attempt_id = $1', [a.id]) : null;
  const details = [['Exam reference', a.reference], ['Score', `${a.score_percent}% (pass mark ${a.pass_mark}%)`], ['Learner ID', a.learner_ref]];
  const why = a.auto_submitted === 'time' ? 'Time ran out, so your exam was submitted automatically. ' : a.auto_submitted === 'integrity' ? 'Your exam was submitted automatically because you left the exam page too many times. ' : '';
  let heading;
  let body;
  let action = { label: 'View your result', url: url(`/exam/${a.id}/result`) };
  if (a.passed && a.review_status === 'pending') {
    heading = `You passed, ${a.first_name}`;
    body = [`${why}Congratulations on passing the ${a.course_title} final exam.`, 'Our team now checks your ID, room scan and exam recording, usually within one business day. We’ll email your certificate as soon as it’s issued.'];
  } else if (a.passed && cert) {
    heading = `You passed, ${a.first_name}`;
    body = [`${why}Congratulations. Your certificate has been issued and employers can verify it online.`];
    details.splice(1, 0, ['Certificate no.', cert.code]);
    action = { label: 'Download your certificate', url: url(`/certificates/${cert.code}.pdf`) };
  } else {
    const left = a.max_attempts + a.extra_attempts - a.used;
    const retakeAt = new Date(new Date(a.submitted_at).getTime() + a.attempt_cooldown_minutes * 60_000);
    heading = 'Not this time';
    body = [
      `${why}You scored ${a.score_percent}% on the ${a.course_title} final exam. The pass mark is ${a.pass_mark}%.`,
      left > 0
        ? `You have ${left} attempt${left === 1 ? '' : 's'} left${a.attempt_cooldown_minutes ? `, and can try again from ${dateTime(retakeAt)} (Toronto time)` : ''}. Your result page shows which topics to review first.`
        : `You’ve used all your attempts. Contact ${config.SUPPORT_EMAIL} with your learner ID to arrange another.`,
    ];
  }
  return sendMail({ to: a.email, subject: subject(a.passed ? 'You passed your exam' : 'Your exam result'), heading, body, details, action, idempotencyKey: `exam-result/${a.id}`, category: 'exam-result' });
}

/** Tells staff an exam is waiting for identity review. One email per reviewer per exam. */
export async function reviewQueuedAlert(attemptId) {
  const a = await one(attemptQuery, [attemptId]);
  if (!a || a.review_status !== 'pending') return 0;
  const staff = await many(`SELECT id, email FROM users WHERE role IN ('admin', 'reviewer') AND disabled_at IS NULL AND deleted_at IS NULL`);
  const flags = await one(`SELECT count(*)::int AS n FROM integrity_events WHERE attempt_id = $1`, [a.id]);
  let sent = 0;
  for (const s of staff) {
    const ok = await sendMail({
      to: s.email,
      subject: subject(`Exam waiting for review: ${a.reference}`),
      heading: 'An exam is waiting for identity review',
      body: ['A learner passed the final exam. Check their ID, room scan and recording, then approve to issue the certificate.'],
      details: [['Exam reference', a.reference], ['Score', `${a.score_percent}%`], ['Integrity events', String(flags.n)], ['Submitted', dateTime(a.submitted_at)]],
      action: { label: 'Open the review', url: url(`/admin/attempts/${a.id}`) },
      footer: 'You get these because you are an administrator or identity reviewer.',
      idempotencyKey: `review-alert/${a.id}/${s.id}`,
      category: 'review-alert',
    });
    if (ok) sent++;
  }
  return sent;
}

export async function certificateIssuedEmail(attemptId) {
  const a = await one(attemptQuery, [attemptId]);
  const cert = a && (await one('SELECT code, expires_at FROM certificates WHERE attempt_id = $1', [attemptId]));
  if (!cert) return false;
  return sendMail({
    to: a.email,
    subject: subject('Your certificate is ready'),
    heading: `Congratulations, ${a.first_name}`,
    body: ['Your exam review is complete and your food handler certificate has been issued. Employers can check it at any time using the certificate number or the QR code on it.'],
    details: [
      ['Certificate no.', cert.code],
      ['Valid until', cert.expires_at ? longDate(cert.expires_at) : 'No expiry'],
      ['Exam reference', a.reference],
      ['Learner ID', a.learner_ref],
    ],
    action: { label: 'Download your certificate', url: url(`/certificates/${cert.code}.pdf`) },
    idempotencyKey: `certificate/${cert.code}`,
    category: 'certificate-issued',
  });
}

export async function reviewRejectedEmail(attemptId, note) {
  const a = await one(attemptQuery, [attemptId]);
  if (!a) return false;
  return sendMail({
    to: a.email,
    subject: subject('About your exam'),
    heading: 'We couldn’t verify your exam',
    body: [`Reason: ${note}`, `If you think this is a mistake, contact ${config.SUPPORT_EMAIL} and quote your exam reference.`],
    details: [['Exam reference', a.reference], ['Learner ID', a.learner_ref]],
    action: { label: 'View the decision', url: url(`/exam/${a.id}/result`) },
    category: 'review-rejected',
  });
}

export async function attemptVoidedEmail(attemptId, reason) {
  const a = await one(attemptQuery, [attemptId]);
  if (!a) return false;
  return sendMail({
    to: a.email,
    subject: subject('Your exam attempt was voided'),
    heading: 'Your exam attempt was voided',
    body: [`Reason: ${reason}`, 'Any certificate from this attempt is no longer valid.', `If you think this is a mistake, contact ${config.SUPPORT_EMAIL} and quote your exam reference.`],
    details: [['Exam reference', a.reference], ['Learner ID', a.learner_ref]],
    category: 'attempt-voided',
  });
}

export async function certificateRevokedEmail(certificateId, reason) {
  const c = await one(
    `SELECT c.code, u.email, u.first_name, u.reference FROM certificates c JOIN users u ON u.id = c.user_id WHERE c.id = $1 AND u.deleted_at IS NULL`,
    [certificateId],
  );
  if (!c) return false;
  return sendMail({
    to: c.email,
    subject: subject('Your certificate was revoked'),
    heading: 'Your certificate was revoked',
    body: [`Reason: ${reason}`, 'Employers checking this certificate number will now see it as revoked.', `If you think this is a mistake, contact ${config.SUPPORT_EMAIL}.`],
    details: [['Certificate no.', c.code], ['Learner ID', c.reference]],
    category: 'certificate-revoked',
  });
}

export function expiryReminderEmail(r) {
  return sendMail({
    to: r.email,
    subject: subject('Your food handler certificate expires soon'),
    heading: `Hi ${r.first_name}, time to renew`,
    body: [`Your ${r.course_title} certificate expires on ${longDate(r.expires_at)}.`, 'Renew before it lapses so you stay certified at work.'],
    details: [['Certificate no.', r.code], ['Learner ID', r.reference]],
    action: { label: 'Renew your certification', url: url('/') },
    idempotencyKey: `expiry-reminder/${r.code}`,
    category: 'expiry-reminder',
  });
}
