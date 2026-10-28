import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import path from 'node:path';
import crypto from 'node:crypto';
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
  // "1" means one proxy hop (Render, Railway, nginx); "true" trusts all; otherwise IPs/subnets.
  const trust = config.TRUST_PROXY;
  app.set('trust proxy', trust === 'true' ? true : /^\d+$/.test(trust) ? Number(trust) : trust);
  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'views'));
  if (config.isProd) app.enable('view cache');

  // Request ID for tracing, and a one-line access log (tokens in URLs are redacted).
  app.use((req, res, next) => {
    const id = crypto.randomUUID();
    res.set('X-Request-Id', id);
    if (!config.isTest) {
      const started = process.hrtime.bigint();
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        const safePath = req.path.replace(/\/[A-Za-z0-9_-]{24,}/g, '/[redacted]');
        console.log(`${new Date().toISOString()} ${id.slice(0, 8)} ${req.method} ${safePath} ${res.statusCode} ${ms.toFixed(0)}ms`);
      });
    }
    next();
  });

  // Production is HTTPS-only. (Health checks from the platform may use plain HTTP.)
  if (config.isProd) {
    app.use((req, res, next) => {
      if (req.secure || req.path === '/healthz') return next();
      res.redirect(301, `${config.appUrl}${req.originalUrl}`);
    });
  }

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          mediaSrc: ["'self'", 'blob:', 'https:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameSrc: ['https://iframe.mediadelivery.net', 'https://player.mediadelivery.net', 'https://www.youtube-nocookie.com', 'https://player.vimeo.com'],
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
    // Camera and microphone are used only by the proctored final exam, on this origin.
    res.set('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(self "https://checkout.stripe.com")');
    next();
  });
  app.use(compression());

  const staticOpts = { maxAge: config.isProd ? '7d' : 0, index: false };
  app.use(express.static(path.join(root, 'public'), staticOpts));
  const fontDir = (pkg) => path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'files');
  app.use('/fonts/jost', express.static(fontDir('@fontsource/jost'), staticOpts));
  app.use('/fonts/plex-sans', express.static(fontDir('@fontsource/ibm-plex-sans'), staticOpts));
  app.use('/fonts/plex-mono', express.static(fontDir('@fontsource/ibm-plex-mono'), staticOpts));
  // Self-hosted face detection for exam proctoring (no third-party scripts or model downloads).
  const faceApi = path.dirname(require.resolve('@vladmandic/face-api/package.json'));
  app.get('/vendor/face-api/face-api.esm.js', (req, res) => res.sendFile(path.join(faceApi, 'dist', 'face-api.esm.js'), { maxAge: staticOpts.maxAge }));
  app.use('/vendor/face-api/model', express.static(path.join(faceApi, 'model'), staticOpts));
  // Self-hosted GSAP for the homepage scroll animations (only the two files the site uses).
  const gsapDist = path.join(path.dirname(require.resolve('gsap/package.json')), 'dist');
  for (const file of ['gsap.min.js', 'ScrollTrigger.min.js']) {
    app.get(`/vendor/gsap/${file}`, (req, res) => res.sendFile(path.join(gsapDist, file), { maxAge: staticOpts.maxAge }));
  }
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
  // Signed-in pages hold personal data: never let a browser or proxy cache them.
  app.use((req, res, next) => {
    if (req.session?.userId) res.set('Cache-Control', 'no-store');
    next();
  });
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
