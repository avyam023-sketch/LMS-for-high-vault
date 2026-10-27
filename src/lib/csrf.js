import { randomToken, safeEqual } from './crypto.js';
import { config } from '../config.js';

const appOrigin = new URL(config.appUrl).origin;

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
  // Defence in depth: browsers label cross-site requests; refuse them outright.
  const origin = req.get('origin');
  if (req.get('sec-fetch-site') === 'cross-site' || (origin && origin !== 'null' && origin !== appOrigin)) {
    return next(Object.assign(new Error('Cross-site request refused.'), { status: 403 }));
  }
  const sent = req.get('x-csrf-token') ?? req.body?._csrf;
  if (sent && req.session.csrf && safeEqual(sent, req.session.csrf)) return next();
  const err = new Error('Your session expired or the form was tampered with. Refresh the page and try again.');
  err.status = 403;
  next(err);
}
