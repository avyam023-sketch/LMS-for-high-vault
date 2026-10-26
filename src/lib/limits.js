import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';

// In-memory counters suit a single instance. For several instances, plug in a shared store
// (e.g. rate-limit-postgresql or rate-limit-redis) — see README.
const make = (windowMs, limit, message) =>
  rateLimit({
    windowMs,
    limit: config.isTest ? 10_000 : limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429);
      if (req.accepts(['html', 'json']) === 'json') return res.json({ error: message });
      res.render('error', { title: 'Slow down', status: 429, message });
    },
  });

export const loginLimiter = make(15 * 60_000, 20, 'Too many sign-in attempts. Wait 15 minutes and try again.');
export const registerLimiter = make(60 * 60_000, 10, 'Too many accounts created from this network. Try again later.');
export const emailLimiter = make(60 * 60_000, 6, 'Too many email requests. Try again in an hour.');
export const verifyLimiter = make(60_000, 30, 'Too many lookups. Wait a minute and try again.');
export const apiLimiter = make(60_000, 240, 'Too many requests. Slow down.');
