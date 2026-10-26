import { Router } from 'express';
import { z } from 'zod';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { many, one, query } from '../db/pool.js';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { requireAuth } from '../lib/auth.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../lib/passwords.js';
import { parse, personName } from '../lib/validate.js';
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

router.post('/account/password', requireAuth, async (req, res) => {
  const row = await one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  const current = String(req.body.current ?? '');
  const next = String(req.body.password ?? '');
  let error = null;
  if (!(await verifyPassword(row.password_hash, current))) error = 'Your current password is incorrect.';
  else if (next !== req.body.confirm) error = 'New passwords do not match.';
  else error = await checkPasswordPolicy(next, { email: req.user.email, name: req.user.last_name });
  if (error) return accountView(req, res, { errors: { password: error } });

  await query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [req.user.id, await hashPassword(next)]);
  await query(`DELETE FROM session WHERE sess->>'userId' = $1 AND sid <> $2`, [req.user.id, req.sessionID]);
  await audit(req, 'user.password_changed', { entity: 'user', entityId: req.user.id });
  flash(req, 'success', 'Password changed.');
  res.redirect('/account');
});

// ---------- Two-step verification (TOTP) ----------
router.get('/account/mfa', requireAuth, async (req, res) => {
  if (req.user.mfa_enabled_at) return res.render('learn/mfa', { title: 'Two-step verification', enabled: true });
  req.session.mfaSetup ??= encrypt(new OTPAuth.Secret({ size: 20 }).base32);
  const secret = decrypt(req.session.mfaSetup);
  const totp = new OTPAuth.TOTP({ issuer: 'High Vault Security', label: req.user.email, secret: OTPAuth.Secret.fromBase32(secret) });
  const qr = await QRCode.toDataURL(totp.toString(), { margin: 1, width: 220 });
  res.render('learn/mfa', {
    title: 'Two-step verification',
    enabled: false,
    qr,
    secret: secret.match(/.{1,4}/g).join(' '),
    required: req.user.role === 'admin' && config.REQUIRE_ADMIN_MFA,
    error: null,
  });
});

router.post('/account/mfa', requireAuth, async (req, res) => {
  if (req.user.mfa_enabled_at || !req.session.mfaSetup) return res.redirect('/account/mfa');
  const secret = decrypt(req.session.mfaSetup);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
  const code = String(req.body.code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code) || totp.validate({ token: code, window: 1 }) === null) {
    flash(req, 'error', 'That code did not match. Check the time on your phone and try again.');
    return res.redirect('/account/mfa');
  }
  await query('UPDATE users SET mfa_secret_enc = $2, mfa_enabled_at = now() WHERE id = $1', [req.user.id, encrypt(secret)]);
  delete req.session.mfaSetup;
  await audit(req, 'user.mfa_enabled', { entity: 'user', entityId: req.user.id });
  flash(req, 'success', 'Two-step verification is on.');
  res.redirect(req.user.role === 'admin' ? '/admin' : '/account');
});

router.post('/account/mfa/disable', requireAuth, async (req, res) => {
  if (req.user.role === 'admin' && config.REQUIRE_ADMIN_MFA) {
    flash(req, 'error', 'Two-step verification is required for administrators.');
    return res.redirect('/account/mfa');
  }
  const row = await one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await verifyPassword(row.password_hash, String(req.body.password ?? '')))) {
    flash(req, 'error', 'Password is incorrect.');
    return res.redirect('/account/mfa');
  }
  await query('UPDATE users SET mfa_secret_enc = NULL, mfa_enabled_at = NULL WHERE id = $1', [req.user.id]);
  await audit(req, 'user.mfa_disabled', { entity: 'user', entityId: req.user.id });
  flash(req, 'success', 'Two-step verification is off.');
  res.redirect('/account');
});

export default router;
