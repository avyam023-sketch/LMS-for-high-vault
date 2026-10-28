import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  // On Render, the public URL is provided automatically.
  APP_URL: z.url().default(process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: bool,
  // The certificate authority that signed the database's TLS certificate, so the connection can be verified:
  // a file path (AWS RDS/Lightsail: global-bundle.pem) or the PEM text itself (Supabase: its root certificate).
  DATABASE_CA_FILE: z.string().optional(),
  DATABASE_CA_CERT: z.string().optional(),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  // 32-byte key, base64 encoded. Encrypts MFA secrets at rest.
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY must be 32 bytes, base64 encoded'),
  // Retired keys, comma-separated, still accepted for decryption during a key rotation.
  ENCRYPTION_KEYS_PREVIOUS: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((k) => k.trim()).filter(Boolean) : []))
    .refine((keys) => keys.every((k) => Buffer.from(k, 'base64').length === 32), 'Each previous key must be 32 bytes, base64 encoded'),
  TRUST_PROXY: z.string().default('loopback'),
  REQUIRE_ADMIN_MFA: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  REQUIRE_EMAIL_VERIFICATION: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  CHECK_BREACHED_PASSWORDS: z.enum(['true', 'false', '1', '0', '']).optional(),
  // Email: Resend's API (recommended) or any SMTP server. Without either, emails print to the console.
  RESEND_API_KEY: z.string().optional(),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('The High Vault Security Academy <no-reply@thehighvaultsecurity.ca>'),
  // Label empty image slots on public pages for every visitor (used by the click-through preview).
  SHOW_IMAGE_SLOTS: bool,
  // First-run bootstrap for one-click deploys: load the course and create the first admin.
  SEED_ON_START: bool,
  // Fill a brand-new site with fictional sample learners, exams and certificates so the admin has
  // something to show. Runs once, only while there are no learners; remove them from Admin → Overview.
  SEED_SAMPLE_DATA: bool,
  ADMIN_EMAIL: z.string().email().optional().or(z.literal('')),
  ADMIN_PASSWORD: z.string().optional(),
  // Bunny Stream → Video library → Security → Token authentication key. Signs chapter video links.
  BUNNY_STREAM_TOKEN_KEY: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // Let Stripe work out and add sales tax at checkout (turn on Stripe Tax in the Stripe dashboard first).
  STRIPE_AUTOMATIC_TAX: bool,
  SUPPORT_EMAIL: z.string().default('info@thehighvaultsecurity.ca'),
  // Days to keep exam ID photos, room scans and snapshots before they are deleted automatically.
  PROCTOR_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  // Evidence is deleted sooner once a decision is made (approved, rejected, failed or voided).
  PROCTOR_RETENTION_AFTER_DECISION_DAYS: z.coerce.number().int().min(0).max(3650).default(30),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

const env = parsed.data;
// The local preview (docker-compose.preview.yml) uses public placeholder keys. Never in production.
if (env.NODE_ENV === 'production' && (env.SESSION_SECRET.startsWith('local-preview-only') || env.ENCRYPTION_KEY === 'bG9jYWwtcHJldmlldy1vbmx5LW5vdC1zZWNyZXQhIQA=')) {
  console.error('Refusing to start: the local-preview keys must not be used in production. Generate new SESSION_SECRET and ENCRYPTION_KEY values.');
  process.exit(1);
}
// A Supabase database is reached over the internet, so never connect to it without a verified TLS connection.
if (env.NODE_ENV === 'production' && /@[^/]*\.supabase\.(co|com)[:/]/.test(env.DATABASE_URL) && !env.DATABASE_CA_CERT && !env.DATABASE_CA_FILE) {
  console.error('Refusing to start: set DATABASE_CA_CERT to Supabase\'s certificate (Project Settings → Database → SSL Configuration).');
  process.exit(1);
}
export const config = {
  ...env,
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  appUrl: env.APP_URL.replace(/\/$/, ''),
  paymentsEnabled: Boolean(env.STRIPE_SECRET_KEY),
  // A Stripe test key: checkout takes the test card 4242 4242 4242 4242 and no real money moves.
  paymentsTestMode: Boolean(env.STRIPE_SECRET_KEY?.startsWith('sk_test_') || env.STRIPE_SECRET_KEY?.startsWith('rk_test_')),
  // On by default in production; set CHECK_BREACHED_PASSWORDS=false to opt out.
  CHECK_BREACHED_PASSWORDS: env.CHECK_BREACHED_PASSWORDS ? ['true', '1'].includes(env.CHECK_BREACHED_PASSWORDS) : env.NODE_ENV === 'production',
};
