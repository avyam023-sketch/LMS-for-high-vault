import { config } from '../config.js';

const dateFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'America/Toronto' });
const dateTimeFmt = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Toronto',
});

export function money(cents, currency = 'cad') {
  if (!cents) return 'Free';
  // Whole amounts read better without cents: US$89 rather than US$89.00.
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: whole ? 0 : 2 }).format(cents / 100);
}

export function duration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h && `${h} hr${h > 1 ? 's' : ''}`, m && `${m} min`].filter(Boolean).join(' ') || '0 min';
}

/** Locals available to every template; also pops the one-time flash message. */
export function viewHelpers(req, res, next) {
  res.locals.flash = req.session.flash ?? null;
  delete req.session.flash;
  res.locals.path = req.path;
  res.locals.appUrl = config.appUrl;
  res.locals.supportEmail = config.SUPPORT_EMAIL;
  res.locals.paymentsTestMode = config.paymentsTestMode;
  res.locals.fmtDate = (d) => (d ? dateFmt.format(new Date(d)) : '—');
  res.locals.fmtDateTime = (d) => (d ? dateTimeFmt.format(new Date(d)) : '—');
  res.locals.money = money;
  res.locals.duration = duration;
  res.locals.title = null;
  next();
}

export function flash(req, type, text) {
  req.session.flash = { type, text };
}
