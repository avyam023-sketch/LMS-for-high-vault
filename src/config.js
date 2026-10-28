import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  // Address to listen on. Behind a reverse proxy on the same server (AWS + Caddy), use 127.0.0.1.
  HOST: z.string().default('0.0.0.0'),
  APP_URL: z.url().default('http://localhost:3000'),
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
  // First-run bootstrap: load the course and create the first admin.
  SEED_ON_START: bool,
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
// Production refuses to start with anything that would leave a real site half-protected or unable to reach learners.
if (env.NODE_ENV === 'production') {
  const problems = [];
  // Keys that have been published (old local-preview and CI files) or are trivially guessable.
  const knownSecret = /^(local-preview-only|ci-only|change-me|changeme|replace)/i.test(env.SESSION_SECRET) || new Set(env.SESSION_SECRET).size < 8;
  const knownKey = ['bG9jYWwtcHJldmlldy1vbmx5LW5vdC1zZWNyZXQhIQA=', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='].includes(env.ENCRYPTION_KEY)
    || new Set(Buffer.from(env.ENCRYPTION_KEY, 'base64')).size < 8;
  if (knownSecret) problems.push('SESSION_SECRET is a placeholder. Generate one with: openssl rand -base64 48');
  if (knownKey) problems.push('ENCRYPTION_KEY is a placeholder. Generate one with: openssl rand -base64 32');
  if (!env.APP_URL.startsWith('https://')) problems.push('APP_URL must be the site\'s https:// address.');
  if (!env.RESEND_API_KEY && !env.SMTP_URL) problems.push('No email provider: set RESEND_API_KEY (or SMTP_URL) so confirmation codes and results reach learners.');
  if (!env.REQUIRE_EMAIL_VERIFICATION) problems.push('REQUIRE_EMAIL_VERIFICATION must stay on in production.');
  if (!env.REQUIRE_ADMIN_MFA) problems.push('REQUIRE_ADMIN_MFA must stay on in production.');
  // A Supabase database is reached over the internet, so never connect to it without a verified TLS connection.
  if (/@[^/]*\.supabase\.(co|com)[:/]/.test(env.DATABASE_URL) && !env.DATABASE_CA_CERT && !env.DATABASE_CA_FILE) {
    problems.push('Set DATABASE_CA_CERT to Supabase\'s certificate (Project Settings → Database → SSL Configuration).');
  }
  if (problems.length) {
    console.error('Refusing to start in production:');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
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
