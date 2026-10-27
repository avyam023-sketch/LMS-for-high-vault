import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

/**
 * Rate-limit counters in Postgres, so limits hold across restarts and across several app
 * instances (an in-memory counter resets on every deploy and is per-process).
 */
class PgStore {
  constructor(name) {
    this.name = name;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async increment(key) {
    const { rows } = await pool.query(
      `INSERT INTO rate_limits (key, hits, reset_at) VALUES ($1, 1, now() + make_interval(secs => $2::int))
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.hits + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= now() THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END
       RETURNING hits, reset_at`,
      [`${this.name}:${key}`, Math.ceil(this.windowMs / 1000)],
    );
    return { totalHits: rows[0].hits, resetTime: rows[0].reset_at };
  }

  async decrement(key) {
    await pool.query('UPDATE rate_limits SET hits = greatest(hits - 1, 0) WHERE key = $1', [`${this.name}:${key}`]);
  }

  async resetKey(key) {
    await pool.query('DELETE FROM rate_limits WHERE key = $1', [`${this.name}:${key}`]);
  }
}

const make = (name, windowMs, limit, message) =>
  rateLimit({
    windowMs,
    limit: config.isTest ? 10_000 : limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: new PgStore(name),
    handler: (req, res) => {
      res.status(429);
      if (req.accepts(['html', 'json']) === 'json') return res.json({ error: message });
      res.render('error', { title: 'Slow down', status: 429, message });
    },
  });

export const loginLimiter = make('login', 15 * 60_000, 20, 'Too many sign-in attempts. Wait 15 minutes and try again.');
export const registerLimiter = make('register', 60 * 60_000, 10, 'Too many accounts created from this network. Try again later.');
export const emailLimiter = make('email', 60 * 60_000, 6, 'Too many email requests. Try again in an hour.');
export const verifyLimiter = make('verify', 60_000, 30, 'Too many lookups. Wait a minute and try again.');
export const apiLimiter = make('api', 60_000, 240, 'Too many requests. Slow down.');
export const sensitiveLimiter = make('sensitive', 60 * 60_000, 10, 'Too many attempts. Try again in an hour.');
