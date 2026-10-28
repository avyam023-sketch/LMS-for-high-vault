import { Router } from 'express';
import { z } from 'zod';
import * as OTPAuth from 'otpauth';
import { one, query } from '../db/pool.js';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { activateSession, signIn, signOut } from '../lib/auth.js';
import crypto from 'node:crypto';
import { decrypt, randomToken, safeEqual, sha256 } from '../lib/crypto.js';
import { emailLimiter, loginLimiter, registerLimiter, sensitiveLimiter } from '../lib/limits.js';
import { accountExistsEmail, passwordResetEmail, verificationEmail, welcomeEmail } from '../lib/notify.js';
import { burnTime, checkPasswordPolicy, hashPassword, verifyPassword } from '../lib/passwords.js';
import { email, parse, personName } from '../lib/validate.js';
import { flash } from '../lib/view-helpers.js';
import { securityNotice } from '../lib/notify.js';

const router = Router();
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

async function issueToken(userId, purpose, hours) {
  const token = randomToken();
  await query('UPDATE email_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL', [userId, purpose]);
  await query(
    `INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [userId, purpose, sha256(token), hours],
  );
  return token;
}

async function consumeToken(token, purpose) {
  return one(
    `UPDATE email_tokens SET used_at = now()
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [sha256(String(token)), purpose],
  );
}

// The 6-digit code is tied to the account it was sent to and keyed with the server secret, so a copy of
// the database can't be used to work codes out. Five wrong tries and it stops working.
const CODE_TRIES = 5;
const codeHash = (userId, code) => crypto.createHmac('sha256', config.SESSION_SECRET).update(`verify:${userId}:${code}`).digest('hex');

export async function sendVerification(user) {
  const token = await issueToken(user.id, 'verify', 48);
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await query(`DELETE FROM email_tokens WHERE user_id = $1 AND purpose = 'verify_code'`, [user.id]);
  await query(
    `INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, 'verify_code', $2, now() + interval '1 hour')`,
    [user.id, codeHash(user.id, code)],
  );
  await verificationEmail(user, `${config.appUrl}/verify-email/${token}`, code);
}

async function markVerified(req, userId) {
  await query('UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1', [userId]);
  await query(`UPDATE email_tokens SET used_at = now() WHERE user_id = $1 AND purpose IN ('verify', 'verify_code') AND used_at IS NULL`, [userId]);
  await audit(req, 'user.email_verified', { entity: 'user', entityId: userId, actorId: userId });
  await welcomeEmail(userId);
}

function afterLogin(req, res) {
  const to = req.session.returnTo;
  delete req.session.returnTo;
  const safe = typeof to === 'string' && to.startsWith('/') && !to.startsWith('//') ? to : null;
  res.redirect(safe ?? (['admin', 'reviewer'].includes(req.user?.role) ? '/admin' : '/dashboard'));
}

// ---------- Register ----------
const registerSchema = z
  .object({
    first_name: personName,
    last_name: personName,
    email,
    password: z.string().max(200),
    confirm: z.string(),
    terms: z.literal('on', { error: 'You must accept the terms to continue.' }),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match.' });

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  req.session.registerShownAt = Date.now();
  res.render('auth/register', { title: 'Create your account', values: {}, errors: {} });
});

router.post('/register', registerLimiter, async (req, res) => {
  // Bot traps: a hidden field people never fill in, and a form submitted faster than a person can type.
  const shownAt = req.session.registerShownAt;
  if (req.body.hv_trap || !shownAt || Date.now() - shownAt < (config.isTest ? 0 : 2500)) {
    await audit(req, 'auth.register_blocked_bot', { meta: { honeypot: Boolean(req.body.hv_trap) } });
    return res.render('auth/check-email', { title: 'Check your email', email: String(req.body.email ?? '').slice(0, 254) });
  }
  const values = { first_name: req.body.first_name, last_name: req.body.last_name, email: req.body.email };
  const { data, errors } = parse(registerSchema, req.body);
  if (errors) return res.status(422).render('auth/register', { title: 'Create your account', values, errors });
  const policy = await checkPasswordPolicy(data.password, { email: data.email, name: data.last_name });
  if (policy) return res.status(422).render('auth/register', { title: 'Create your account', values, errors: { password: policy } });

  const hash = await hashPassword(data.password);
  const user = await one(
    `INSERT INTO users (email, password_hash, first_name, last_name, email_verified_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END)
     ON CONFLICT (email) DO NOTHING
     RETURNING id, email, first_name, role, email_verified_at`,
    [data.email, hash, data.first_name, data.last_name, !config.REQUIRE_EMAIL_VERIFICATION],
  );

  if (!user) {
    // Don't reveal which emails are registered. Tell the real owner instead.
    await accountExistsEmail(data.email);
    return res.render('auth/check-email', { title: 'Check your email', email: data.email });
  }

  await audit(req, 'user.register', { entity: 'user', entityId: user.id, actorId: user.id });
  if (!config.REQUIRE_EMAIL_VERIFICATION) {
    await welcomeEmail(user.id);
    await signIn(req, user);
    req.user = user;
    return res.redirect('/dashboard');
  }
  await sendVerification(user);
  await signIn(req, user);
  res.redirect('/verify-email');
});

// ---------- Email verification ----------
router.get('/verify-email', (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (req.user.email_verified_at) return res.redirect('/dashboard');
  res.render('auth/verify-email', { title: 'Confirm your email' });
});

router.post('/verify-email/resend', emailLimiter, async (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (!req.user.email_verified_at) await sendVerification(req.user);
  flash(req, 'success', `We sent a new code to ${req.user.email}.`);
  res.redirect('/verify-email');
});

router.post('/verify-email/code', sensitiveLimiter, async (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (req.user.email_verified_at) return res.redirect('/dashboard');
  const code = String(req.body.code ?? '').replace(/\D/g, '');
  const row = await one(
    `SELECT id, token_hash, attempts FROM email_tokens
      WHERE user_id = $1 AND purpose = 'verify_code' AND used_at IS NULL AND expires_at > now()`,
    [req.user.id],
  );
  if (!row) {
    flash(req, 'error', 'That code has expired. Send yourself a new one below.');
    return res.redirect('/verify-email');
  }
  if (code.length !== 6 || !safeEqual(codeHash(req.user.id, code), row.token_hash)) {
    const { rows } = await query(
      `UPDATE email_tokens SET attempts = attempts + 1, used_at = CASE WHEN attempts + 1 >= $2 THEN now() END WHERE id = $1 RETURNING attempts`,
      [row.id, CODE_TRIES],
    );
    const left = CODE_TRIES - rows[0].attempts;
    flash(req, 'error', left > 0
      ? `That code isn’t right. ${left} ${left === 1 ? 'try' : 'tries'} left.`
      : 'Too many wrong codes. Send yourself a new one below.');
    return res.redirect('/verify-email');
  }
  await markVerified(req, req.user.id);
  flash(req, 'success', 'Email confirmed. You can start your course.');
  res.redirect('/dashboard');
});

router.get('/verify-email/:token', async (req, res) => {
  const row = await consumeToken(req.params.token, 'verify');
  if (!row) {
    return res.status(400).render('error', {
      title: 'Link expired', status: 400, message: 'This confirmation link is invalid or has expired. Sign in to request a new one.',
    });
  }
  await markVerified(req, row.user_id);
  flash(req, 'success', 'Email confirmed. You can start your course.');
  res.redirect(req.user ? '/dashboard' : '/login');
});

// ---------- Login ----------
router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('auth/login', { title: 'Sign in', values: {}, error: null });
});

router.post('/login', loginLimiter, async (req, res) => {
  const emailValue = String(req.body.email ?? '').trim().toLowerCase().slice(0, 254);
  const password = String(req.body.password ?? '').slice(0, 200);
  const fail = (error = 'Email or password is incorrect.') =>
    res.status(401).render('auth/login', { title: 'Sign in', values: { email: emailValue }, error });

  const user = await one(
    'SELECT id, email, first_name, role, password_hash, failed_logins, locked_until, disabled_at, mfa_enabled_at FROM users WHERE email = $1 AND deleted_at IS NULL',
    [emailValue],
  );
  if (!user) {
    await burnTime(password);
    return fail();
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    await burnTime(password);
    return fail(`Too many failed attempts. This account is locked for up to ${LOCK_MINUTES} minutes.`);
  }
  if (!(await verifyPassword(user.password_hash, password))) {
    const failed = user.failed_logins + 1;
    await query(
      `UPDATE users SET failed_logins = $2,
              locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) END
        WHERE id = $1`,
      [user.id, failed >= MAX_FAILED ? 0 : failed, failed >= MAX_FAILED, LOCK_MINUTES],
    );
    await audit(req, 'auth.login_failed', { entity: 'user', entityId: user.id, actorId: user.id });
    return fail();
  }
  if (user.disabled_at) return fail('This account has been disabled. Contact support for help.');

  await signIn(req, user, { mfaPending: Boolean(user.mfa_enabled_at) });
  if (user.mfa_enabled_at) return res.redirect('/login/mfa');
  await audit(req, 'auth.login', { entity: 'user', entityId: user.id, actorId: user.id });
  req.user = user;
  afterLogin(req, res);
});

router.get('/login/mfa', (req, res) => {
  if (!req.pendingUser) return res.redirect('/login');
  res.render('auth/mfa', { title: 'Two-step verification', error: null });
});

router.post('/login/mfa', loginLimiter, async (req, res) => {
  const pending = req.pendingUser;
  if (!pending) return res.redirect('/login');
  const row = await one('SELECT mfa_secret_enc, mfa_last_step, failed_logins, locked_until FROM users WHERE id = $1', [pending.id]);
  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    await signOut(req);
    return res.status(401).render('auth/login', { title: 'Sign in', values: {}, error: `Too many failed attempts. This account is locked for up to ${LOCK_MINUTES} minutes.` });
  }
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(decrypt(row.mfa_secret_enc, { purpose: 'mfa', context: pending.id })) });
  const code = String(req.body.code ?? '').replace(/\s/g, '');
  const delta = /^\d{6}$/.test(code) ? totp.validate({ token: code, window: 1 }) : null;
  // Reject replay of a code already used in the same 30-second window.
  const step = delta === null ? null : Math.floor(Date.now() / 30_000) + delta;
  if (delta === null || Number(row.mfa_last_step) >= step) {
    // Wrong codes count toward the same lockout as wrong passwords.
    const failed = row.failed_logins + 1;
    await query(
      `UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) END WHERE id = $1`,
      [pending.id, failed >= MAX_FAILED ? 0 : failed, failed >= MAX_FAILED, LOCK_MINUTES],
    );
    await audit(req, 'auth.mfa_failed', { entity: 'user', entityId: pending.id, actorId: pending.id });
    return res.status(401).render('auth/mfa', { title: 'Two-step verification', error: 'That code is not valid. Try the latest one.' });
  }
  await query('UPDATE users SET mfa_last_step = $2 WHERE id = $1', [pending.id, step]);
  await activateSession(req, pending.id);
  await audit(req, 'auth.login', { entity: 'user', entityId: pending.id, actorId: pending.id, meta: { mfa: true } });
  req.user = pending;
  afterLogin(req, res);
});

router.post('/logout', async (req, res) => {
  if (req.user) await audit(req, 'auth.logout', { entity: 'user', entityId: req.user.id });
  await signOut(req);
  res.clearCookie(config.isProd ? '__Host-hv.sid' : 'hv.sid');
  res.redirect('/');
});

// ---------- Password reset ----------
router.get('/forgot-password', (req, res) => res.render('auth/forgot', { title: 'Reset your password', sent: false }));

router.post('/forgot-password', emailLimiter, async (req, res) => {
  const { data } = parse(z.object({ email }), req.body);
  if (data) {
    const user = await one('SELECT id, email, first_name FROM users WHERE email = $1 AND disabled_at IS NULL', [data.email]);
    if (user) {
      const token = await issueToken(user.id, 'reset', 1);
      await passwordResetEmail(user, `${config.appUrl}/reset-password/${token}`);
      await audit(req, 'auth.reset_requested', { entity: 'user', entityId: user.id, actorId: user.id });
    }
  }
  // Same response either way, so the form can't be used to discover accounts.
  res.render('auth/forgot', { title: 'Reset your password', sent: true });
});

router.get('/reset-password/:token', async (req, res) => {
  const valid = await one(
    `SELECT 1 FROM email_tokens WHERE token_hash = $1 AND purpose = 'reset' AND used_at IS NULL AND expires_at > now()`,
    [sha256(req.params.token)],
  );
  if (!valid) return res.status(400).render('error', { title: 'Link expired', status: 400, message: 'This reset link is invalid or has expired.' });
  res.render('auth/reset', { title: 'Choose a new password', token: req.params.token, error: null });
});

router.post('/reset-password/:token', emailLimiter, async (req, res) => {
  const password = String(req.body.password ?? '');
  const render = (error) => res.status(422).render('auth/reset', { title: 'Choose a new password', token: req.params.token, error });
  if (password !== req.body.confirm) return render('Passwords do not match.');
  const tokenRow = await one(
    `SELECT t.user_id, u.email, u.last_name FROM email_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.purpose = 'reset' AND t.used_at IS NULL AND t.expires_at > now()`,
    [sha256(req.params.token)],
  );
  if (!tokenRow) return render('This reset link is invalid or has expired.');
  const policy = await checkPasswordPolicy(password, { email: tokenRow.email, name: tokenRow.last_name });
  if (policy) return render(policy);
  if (!(await consumeToken(req.params.token, 'reset'))) return render('This reset link is invalid or has expired.');

  await query(
    `UPDATE users SET password_hash = $2, password_changed_at = now(), failed_logins = 0, locked_until = NULL, active_session_id = NULL,
            email_verified_at = coalesce(email_verified_at, now()), updated_at = now() WHERE id = $1`,
    [tokenRow.user_id, await hashPassword(password)],
  );
  // Sign out everywhere after a password reset.
  await query(`DELETE FROM session WHERE sess->>'userId' = $1`, [tokenRow.user_id]);
  await audit(req, 'auth.password_reset', { entity: 'user', entityId: tokenRow.user_id, actorId: tokenRow.user_id });
  await securityNotice({ email: tokenRow.email }, 'Your password was reset', req.ip);
  flash(req, 'success', 'Password updated. Sign in with your new password.');
  res.redirect('/login');
});

export default router;
