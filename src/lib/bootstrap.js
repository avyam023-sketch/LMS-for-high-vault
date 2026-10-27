import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { seed } from '../db/seed.js';
import { checkPasswordPolicy, hashPassword } from './passwords.js';

/**
 * First-run setup for hosted deploys (Render, Railway…): loads the course if it's missing and
 * creates the first administrator from ADMIN_EMAIL / ADMIN_PASSWORD if no admin exists yet.
 * Both steps are no-ops once done, so it's safe on every boot.
 */
export async function bootstrap() {
  if (config.SEED_ON_START) await seed({ log: (m) => console.log(`[bootstrap] ${m}`) });

  if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) return;
  const existing = await one(`SELECT 1 FROM users WHERE role = 'admin' AND deleted_at IS NULL LIMIT 1`);
  if (existing) return;
  const problem = await checkPasswordPolicy(config.ADMIN_PASSWORD, { email: config.ADMIN_EMAIL });
  if (problem) {
    console.error(`[bootstrap] ADMIN_PASSWORD rejected: ${problem} No admin created.`);
    return;
  }
  await query(
    `INSERT INTO users (email, password_hash, first_name, last_name, role, email_verified_at)
     VALUES (lower($1), $2, 'Site', 'Administrator', 'admin', now())
     ON CONFLICT (email) DO UPDATE SET role = 'admin', email_verified_at = coalesce(users.email_verified_at, now())`,
    [config.ADMIN_EMAIL, await hashPassword(config.ADMIN_PASSWORD)],
  );
  console.log(`[bootstrap] Created administrator ${config.ADMIN_EMAIL}. Remove ADMIN_PASSWORD from the environment now.`);
}
