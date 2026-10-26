import { randomToken, safeEqual } from './crypto.js';

/**
 * Synchronizer-token CSRF protection. The token lives in the server-side session;
 * forms send it as `_csrf`, fetch() calls as the `x-csrf-token` header.
 * The token is created lazily (templates call csrfToken()), so pages without forms create no session.
 */
export function csrf(req, res, next) {
  // A function, not a value: Express copies locals on every render, which would
  // otherwise create a session for every anonymous page view.
  res.locals.csrfToken = () => (req.session.csrf ??= randomToken(24));
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = req.get('x-csrf-token') ?? req.body?._csrf;
  if (sent && req.session.csrf && safeEqual(sent, req.session.csrf)) return next();
  const err = new Error('Your session expired or the form was tampered with. Refresh the page and try again.');
  err.status = 403;
  next(err);
}
