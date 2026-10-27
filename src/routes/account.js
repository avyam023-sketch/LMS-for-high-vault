import { Router } from 'express';
import { z } from 'zod';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { many, one, query, tx } from '../db/pool.js';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../lib/mailer.js';
import { requireAuth, signOut } from '../lib/auth.js';
import { decrypt, encrypt, randomToken } from '../lib/crypto.js';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../lib/passwords.js';
import { parse, personName } from '../lib/validate.js';
import { securityNotice } from '../lib/notify.js';
import { sensitiveLimiter } from '../lib/limits.js';
import { flash } from '../lib/view-helpers.js';

const router = Router();

async function accountView(req, res, extra = {}) {
  const certificates = await many('SELECT code FROM certificates WHERE user_id = $1', [req.user.id]);
  res.render('learn/account', {
    title: 'Your account',
    nameLocked: certificates.length > 0,
    errors: {},
    values: req.user,
    ...extra,
  });
}

router.get('/account', requireAuth, (req, res) => accountView(req, res));

router.post('/account/profile', requireAuth, async (req, res) => {
  const { data, errors } = parse(z.object({ first_name: personName, last_name: personName }), req.body);
  if (errors) return accountView(req, res, { errors, values: { ...req.user, ...req.body } });
  // The name prints on certificates. Once one is issued, only an admin can change it.
  const certs = await one('SELECT count(*)::int AS n FROM certificates WHERE user_id = $1', [req.user.id]);
  if (certs.n > 0) {
    flash(req, 'warn', `Your name is on an issued certificate. Contact ${config.SUPPORT_EMAIL} to correct it.`);
    return res.redirect('/account');
  }
  await query('UPDATE users SET first_name = $2, last_name = $3, updated_at = now() WHERE id = $1', [
    req.user.id,
    data.first_name,
    data.last_name,
  ]);
  await audit(req, 'user.profile_updated', { entity: 'user', entityId: req.user.id });
  flash(req, 'success', 'Profile saved.');
  res.redirect('/account');
});

router.post('/account/password', requireAuth, sensitiveLimiter, async (req, res) => {
  const row = await one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  const current = String(req.body.current ?? '');
  const next = String(req.body.password ?? '');
  let error = null;
  if (!(await verifyPassword(row.password_hash, current))) error = 'Your current password is incorrect.';
  else if (next !== req.body.confirm) error = 'New passwords do not match.';
  else error = await checkPasswordPolicy(next, { email: req.user.email, name: req.user.last_name });
  if (error) return accountView(req, res, { errors: { password: error } });

  await query('UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1', [req.user.id, await hashPassword(next)]);
  await query(`DELETE FROM session WHERE sess->>'userId' = $1 AND sid <> $2`, [req.user.id, req.sessionID]);
  await audit(req, 'user.password_changed', { entity: 'user', entityId: req.user.id });
  await securityNotice(req.user, 'Your password was changed', req.ip);
  flash(req, 'success', 'Password changed.');
  res.redirect('/account');
});

// ---------- Two-step verification (TOTP) ----------
router.get('/account/mfa', requireAuth, async (req, res) => {
  if (req.user.mfa_enabled_at) return res.render('learn/mfa', { title: 'Two-step verification', enabled: true });
  const mfaCtx = { purpose: 'mfa-setup', context: req.user.id };
  req.session.mfaSetup ??= encrypt(new OTPAuth.Secret({ size: 20 }).base32, mfaCtx);
  const secret = decrypt(req.session.mfaSetup, mfaCtx);
  const totp = new OTPAuth.TOTP({ issuer: 'High Vault Security', label: req.user.email, secret: OTPAuth.Secret.fromBase32(secret) });
  const qr = await QRCode.toDataURL(totp.toString(), { margin: 1, width: 220 });
  res.render('learn/mfa', {
    title: 'Two-step verification',
    enabled: false,
    qr,
    secret: secret.match(/.{1,4}/g).join(' '),
    required: ['admin', 'reviewer'].includes(req.user.role) && config.REQUIRE_ADMIN_MFA,
    error: null,
  });
});

router.post('/account/mfa', requireAuth, async (req, res) => {
  if (req.user.mfa_enabled_at || !req.session.mfaSetup) return res.redirect('/account/mfa');
  const secret = decrypt(req.session.mfaSetup, { purpose: 'mfa-setup', context: req.user.id });
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
  const code = String(req.body.code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code) || totp.validate({ token: code, window: 1 }) === null) {
    flash(req, 'error', 'That code did not match. Check the time on your phone and try again.');
    return res.redirect('/account/mfa');
  }
  await query('UPDATE users SET mfa_secret_enc = $2, mfa_enabled_at = now() WHERE id = $1', [req.user.id, encrypt(secret, { purpose: 'mfa', context: req.user.id })]);
  delete req.session.mfaSetup;
  await audit(req, 'user.mfa_enabled', { entity: 'user', entityId: req.user.id });
  await securityNotice(req.user, 'Two-step verification was turned on', req.ip);
  flash(req, 'success', 'Two-step verification is on.');
  res.redirect(['admin', 'reviewer'].includes(req.user.role) ? '/admin' : '/account');
});

router.post('/account/mfa/disable', requireAuth, sensitiveLimiter, async (req, res) => {
  if (['admin', 'reviewer'].includes(req.user.role) && config.REQUIRE_ADMIN_MFA) {
    flash(req, 'error', 'Two-step verification is required for staff accounts.');
    return res.redirect('/account/mfa');
  }
  const row = await one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await verifyPassword(row.password_hash, String(req.body.password ?? '')))) {
    flash(req, 'error', 'Password is incorrect.');
    return res.redirect('/account/mfa');
  }
  await query('UPDATE users SET mfa_secret_enc = NULL, mfa_enabled_at = NULL WHERE id = $1', [req.user.id]);
  await audit(req, 'user.mfa_disabled', { entity: 'user', entityId: req.user.id });
  await securityNotice(req.user, 'Two-step verification was turned off', req.ip);
  flash(req, 'success', 'Two-step verification is off.');
  res.redirect('/account');
});

// ---------- Privacy: export and delete ----------

/** Everything we hold about the learner, as a JSON download (exam media is listed, not included). */
router.get('/account/export', requireAuth, async (req, res) => {
  const id = req.user.id;
  const data = {
    exported_at: new Date().toISOString(),
    profile: await one(
      'SELECT email, first_name, last_name, role, email_verified_at, mfa_enabled_at, created_at, last_login_at FROM users WHERE id = $1',
      [id],
    ),
    enrollments: await many(
      'SELECT c.title AS course, e.enrolled_at, e.completed_at, e.source FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.user_id = $1',
      [id],
    ),
    lessons: await many(
      `SELECT l.title AS chapter, lp.seconds_spent, lp.first_viewed_at, lp.completed_at
         FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id WHERE lp.user_id = $1`,
      [id],
    ),
    quiz_answers: await many(
      'SELECT q.prompt, qa.tries, qa.correct_at FROM quiz_answers qa JOIN questions q ON q.id = qa.question_id WHERE qa.user_id = $1',
      [id],
    ),
    exam_attempts: await many(
      `SELECT a.id, c.title AS course, a.status, a.started_at, a.submitted_at, a.score_percent, a.passed, a.review_status,
              a.focus_violations, a.ip, a.user_agent,
              (SELECT json_agg(json_build_object('kind', e.kind, 'at', e.occurred_at, 'detail', e.detail) ORDER BY e.occurred_at)
                 FROM integrity_events e WHERE e.attempt_id = a.id) AS integrity_events,
              (SELECT json_agg(json_build_object('kind', m.kind, 'uploaded_at', m.created_at, 'bytes', m.byte_size) ORDER BY m.created_at)
                 FROM proctor_media m WHERE m.attempt_id = a.id) AS proctoring_files
         FROM exam_attempts a JOIN courses c ON c.id = a.course_id WHERE a.user_id = $1 ORDER BY a.started_at`,
      [id],
    ),
    certificates: await many(
      'SELECT code, full_name, course_title, score_percent, issued_at, expires_at, revoked_at FROM certificates WHERE user_id = $1',
      [id],
    ),
    payments: await many('SELECT amount_cents, currency, status, created_at, paid_at FROM payments WHERE user_id = $1', [id]),
    account_activity: await many(
      'SELECT action, ip, created_at FROM audit_log WHERE actor_id = $1 ORDER BY created_at DESC LIMIT 500',
      [id],
    ),
    note: 'Proctoring photos and videos are listed but not included. To request copies, email ' + config.SUPPORT_EMAIL + '.',
  };
  await audit(req, 'user.data_exported', { entity: 'user', entityId: id });
  res.set({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="high-vault-my-data-${new Date().toISOString().slice(0, 10)}.json"`,
  });
  res.send(JSON.stringify(data, null, 2));
});

/**
 * Deletes the learner's account. Personal data is erased; issued certificates stay verifiable
 * (number, name, course, dates) because employers rely on them — the privacy policy says so.
 */
router.post('/account/delete', requireAuth, sensitiveLimiter, async (req, res) => {
  if (req.user.role !== 'student') {
    flash(req, 'error', 'Staff accounts must have their staff access removed before they can be deleted.');
    return res.redirect('/account');
  }
  const row = await one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (String(req.body.confirm ?? '').trim().toUpperCase() !== 'DELETE' || !(await verifyPassword(row.password_hash, String(req.body.del_password ?? '')))) {
    flash(req, 'error', 'Type DELETE and enter your current password to delete your account.');
    return res.redirect('/account#delete');
  }
  const id = req.user.id;
  const email = req.user.email;
  await tx(async (db) => {
    await db.query(`DELETE FROM proctor_media WHERE attempt_id IN (SELECT id FROM exam_attempts WHERE user_id = $1)`, [id]);
    await db.query(`UPDATE exam_attempts SET ip = NULL, user_agent = NULL, evidence_purged_at = coalesce(evidence_purged_at, now()) WHERE user_id = $1`, [id]);
    await db.query(`UPDATE integrity_events SET ip = NULL WHERE attempt_id IN (SELECT id FROM exam_attempts WHERE user_id = $1)`, [id]);
    await db.query('DELETE FROM quiz_answers WHERE user_id = $1', [id]);
    await db.query('DELETE FROM lesson_progress WHERE user_id = $1', [id]);
    await db.query('DELETE FROM email_tokens WHERE user_id = $1', [id]);
    await db.query('UPDATE audit_log SET ip = NULL WHERE actor_id = $1', [id]);
    await db.query(
      `UPDATE users SET email = $2, first_name = 'Deleted', last_name = 'User', phone = NULL, password_hash = $3,
              mfa_secret_enc = NULL, mfa_enabled_at = NULL, active_session_id = NULL, disabled_at = now(), deleted_at = now(), updated_at = now()
        WHERE id = $1`,
      [id, `deleted+${id}@deleted.invalid`, `!disabled!${randomToken()}`],
    );
    await db.query(`DELETE FROM session WHERE sess->>'userId' = $1`, [id]);
  });
  await audit(req, 'user.account_deleted', { entity: 'user', entityId: id, actorId: id });
  await sendMail({
    to: email,
    subject: 'Your account has been deleted — The High Vault Security',
    heading: 'Account deleted',
    body: ['Your account and personal data have been deleted.', 'Any certificate already issued remains verifiable by its number until it expires, as described in our privacy policy.'],
  }).catch(() => {});
  await signOut(req);
  res.redirect('/?deleted=1');
});

export default router;
