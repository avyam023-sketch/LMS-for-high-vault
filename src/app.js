import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { loadUser } from './lib/auth.js';
import { csrf } from './lib/csrf.js';
import { viewHelpers } from './lib/view-helpers.js';
import publicRoutes from './routes/public.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/account.js';
import learnRoutes from './routes/learn.js';
import examRoutes from './routes/exam.js';
import adminRoutes from './routes/admin.js';
import paymentRoutes, { stripeWebhook } from './routes/payments.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY === 'true' ? true : config.TRUST_PROXY);
  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'views'));
  if (config.isProd) app.enable('view cache');

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameSrc: ['https://www.youtube-nocookie.com', 'https://player.vimeo.com'],
          formAction: ["'self'", 'https://checkout.stripe.com'],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          objectSrc: ["'none'"],
          ...(config.isProd ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      strictTransportSecurity: config.isProd ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
  app.use((req, res, next) => {
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self "https://checkout.stripe.com")');
    next();
  });
  app.use(compression());

  const staticOpts = { maxAge: config.isProd ? '7d' : 0, index: false };
  app.use(express.static(path.join(root, 'public'), staticOpts));
  const fontDir = (pkg) => path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'files');
  app.use('/fonts/jost', express.static(fontDir('@fontsource/jost'), staticOpts));
  app.use('/fonts/plex-sans', express.static(fontDir('@fontsource/ibm-plex-sans'), staticOpts));
  app.use('/fonts/plex-mono', express.static(fontDir('@fontsource/ibm-plex-mono'), staticOpts));
  app.get('/healthz', async (req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });

  // Stripe signs the raw body, so this route must see it before the body parsers.
  app.post('/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), stripeWebhook);

  app.use(express.urlencoded({ extended: false, limit: '200kb' }));
  app.use(express.json({ limit: '50kb' }));

  const PgStore = connectPgSimple(session);
  app.use(
    session({
      name: config.isProd ? '__Host-hv.sid' : 'hv.sid',
      store: new PgStore({ pool, tableName: 'session', pruneSessionInterval: config.isTest ? false : 60 * 15 }),
      secret: config.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        secure: config.isProd,
        sameSite: 'lax',
        path: '/',
        maxAge: 1000 * 60 * 60 * 8, // 8 hours idle timeout
      },
    }),
  );
  app.use(loadUser);
  app.use(csrf);
  app.use(viewHelpers);

  app.use(publicRoutes);
  app.use(authRoutes);
  app.use(accountRoutes);
  app.use(paymentRoutes);
  app.use(learnRoutes);
  app.use(examRoutes);
  app.use('/admin', adminRoutes);

  app.use((req, res) => res.status(404).render('error', { title: 'Page not found', status: 404, message: "We couldn't find that page." }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    const message = status >= 500 ? 'Something went wrong on our side. Please try again.' : err.message;
    Object.assign(res.locals, { user: res.locals.user ?? null, flash: res.locals.flash ?? null, path: req.path, title: null });
    res.locals.supportEmail ??= config.SUPPORT_EMAIL;
    if (req.accepts(['html', 'json']) === 'json' || req.is('json')) return res.status(status).json({ error: message });
    res.status(status).render('error', { title: status === 404 ? 'Page not found' : 'Error', status, message });
  });

  return app;
}
