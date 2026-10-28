import { one, query } from '../db/pool.js';
import { config } from '../config.js';

const USER_COLUMNS = `id, reference, email, first_name, last_name, role, email_verified_at, mfa_enabled_at,
  active_session_id, disabled_at, created_at`;

/** Loads req.user from the session and enforces one active session per account. */
export async function loadUser(req, res, next) {
  res.locals.user = null;
  const id = req.session.userId;
  if (!id) return next();
  const user = await one(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  // Absolute session lifetime, however active the user is: 12 hours for staff, 7 days for learners.
  const maxAge = user && user.role !== 'student' ? 12 * 3600_000 : 7 * 24 * 3600_000;
  if (user && req.session.createdAt && Date.now() - req.session.createdAt > maxAge) {
    await new Promise((resolve) => req.session.regenerate(resolve));
    req.session.flash = { type: 'warn', text: 'For your security, please sign in again.' };
    return next();
  }
  // Password checked, MFA code still owed: not signed in yet, and other sessions stay untouched.
  if (req.session.mfaPending) {
    if (user && !user.disabled_at) req.pendingUser = user;
    return next();
  }
  const kickedOut = user && user.active_session_id !== req.sessionID;
  if (!user || user.disabled_at || kickedOut) {
    await new Promise((resolve) => req.session.regenerate(resolve));
    if (kickedOut) req.session.flash = { type: 'warn', text: 'You were signed out because your account signed in on another device.' };
    return next();
  }
  req.user = user;
  res.locals.user = user;
  next();
}

export function requireAuth(req, res, next) {
  if (req.user) {
    if (config.REQUIRE_EMAIL_VERIFICATION && !req.user.email_verified_at) return res.redirect('/verify-email');
    return next();
  }
  if (req.method === 'GET') req.session.returnTo = req.originalUrl;
  if (req.accepts(['html', 'json']) === 'json') return res.status(401).json({ error: 'Sign in required' });
  res.redirect('/login');
}

export const isStaff = (user) => user?.role === 'admin' || user?.role === 'reviewer';

/** Admins and identity reviewers. Reviewers are further limited to the review queue (see routes/admin.js). */
export function requireStaff(req, res, next) {
  if (!req.user) return requireAuth(req, res, next);
  if (!isStaff(req.user)) {
    const err = new Error('Not found');
    err.status = 404; // Do not reveal the admin area exists.
    return next(err);
  }
  if (config.REQUIRE_ADMIN_MFA && !req.user.mfa_enabled_at) return res.redirect('/account/mfa');
  next();
}

/**
 * Signs a user in with a fresh session id (prevents fixation). With mfaPending the session only
 * proves the password; call activateSession() once the second factor checks out.
 */
export async function signIn(req, user, { mfaPending = false } = {}) {
  const returnTo = req.session.returnTo;
  await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
  req.session.userId = user.id;
  req.session.createdAt = Date.now();
  if (returnTo) req.session.returnTo = returnTo;
  if (mfaPending) {
    req.session.mfaPending = true;
    await new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
    return;
  }
  await activateSession(req, user.id);
}

/** Makes this the account's only active session: any other device is signed out. */
export async function activateSession(req, userId) {
  delete req.session.mfaPending;
  await query(
    `UPDATE users SET active_session_id = $2, last_login_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1`,
    [userId, req.sessionID],
  );
  await query(`DELETE FROM session WHERE sess->>'userId' = $1 AND sid <> $2`, [userId, req.sessionID]);
  await new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}

export async function signOut(req) {
  if (req.session.userId) {
    await query('UPDATE users SET active_session_id = NULL WHERE id = $1 AND active_session_id = $2', [
      req.session.userId,
      req.sessionID,
    ]);
  }
  await new Promise((resolve) => req.session.destroy(resolve));
}
