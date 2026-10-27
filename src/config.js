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
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('The High Vault Security Academy <no-reply@thehighvaultsecurity.ca>'),
  // First-run bootstrap for one-click deploys: load the course and create the first admin.
  SEED_ON_START: bool,
  ADMIN_EMAIL: z.string().email().optional().or(z.literal('')),
  ADMIN_PASSWORD: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
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
export const config = {
  ...env,
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  appUrl: env.APP_URL.replace(/\/$/, ''),
  paymentsEnabled: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET),
  // On by default in production; set CHECK_BREACHED_PASSWORDS=false to opt out.
  CHECK_BREACHED_PASSWORDS: env.CHECK_BREACHED_PASSWORDS ? ['true', '1'].includes(env.CHECK_BREACHED_PASSWORDS) : env.NODE_ENV === 'production',
};
