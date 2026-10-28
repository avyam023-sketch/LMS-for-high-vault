import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { seed } from '../db/seed.js';
import { withoutEmail } from './mailer.js';
import { checkPasswordPolicy, hashPassword } from './passwords.js';

/**
 * First-run setup for hosted deploys (Render, Railway…): loads the course if it's missing and
 * creates the first administrator from ADMIN_EMAIL / ADMIN_PASSWORD if no admin exists yet.
 * Both steps are no-ops once done, so it's safe on every boot.
 */
export async function bootstrap() {
  if (config.SEED_ON_START) await seed({ log: (m) => console.log(`[bootstrap] ${m}`) });
  await createFirstAdmin();
  if (config.SEED_SAMPLE_DATA) await loadSampleData();
}

async function createFirstAdmin() {
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

/**
 * Sample learners for a live demo. Loaded once, only into a site with no learners yet. Their shared
 * password is random and never shown, so nobody can sign in as them; the real admin approves their exams.
 */
async function loadSampleData() {
  if (await one(`SELECT 1 FROM audit_log WHERE action = 'sample_data.loaded' LIMIT 1`)) return;
  if (await one(`SELECT 1 FROM users WHERE role = 'student' LIMIT 1`)) {
    console.log('[bootstrap] SEED_SAMPLE_DATA is on but the site already has learners; skipping sample data.');
    return;
  }
  if (!(await one('SELECT 1 FROM courses LIMIT 1'))) return;
  const admin = await one(`SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL ORDER BY created_at LIMIT 1`);
  if (!admin) {
    console.log('[bootstrap] SEED_SAMPLE_DATA is on but there is no admin yet (set ADMIN_EMAIL and ADMIN_PASSWORD); skipping sample data.');
    return;
  }
  const { seedDemo } = await import('../db/sample-data.js');
  await withoutEmail(() => seedDemo({ password: randomBytes(32).toString('base64url'), reviewerId: admin.id }));
  await query(`INSERT INTO audit_log (actor_id, action, entity) VALUES ($1, 'sample_data.loaded', 'site')`, [admin.id]);
  console.log('[bootstrap] Loaded sample learners. Remove them from Admin → Overview before real learners sign up.');
}
