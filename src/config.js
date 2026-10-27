import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: bool,
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  // 32-byte key, base64 encoded. Encrypts MFA secrets at rest.
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY must be 32 bytes, base64 encoded'),
  TRUST_PROXY: z.string().default('loopback'),
  REQUIRE_ADMIN_MFA: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  REQUIRE_EMAIL_VERIFICATION: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  CHECK_BREACHED_PASSWORDS: bool,
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('The High Vault Security Academy <no-reply@thehighvaultsecurity.ca>'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  SUPPORT_EMAIL: z.string().default('info@thehighvaultsecurity.ca'),
  // Days to keep exam ID photos, room scans and snapshots before they are deleted automatically.
  PROCTOR_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
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
};
