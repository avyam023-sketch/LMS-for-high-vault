// Creates (or promotes) an administrator account.
// Usage: npm run create-admin -- admin@example.com "First" "Last"
// The password is read from ADMIN_PASSWORD, or a strong one is generated and printed once.
import crypto from 'node:crypto';
import { pool, one } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { checkPasswordPolicy, hashPassword } from '../src/lib/passwords.js';

const [email, first = 'Site', last = 'Administrator'] = process.argv.slice(2);
if (!email || !email.includes('@')) {
  console.error('Usage: npm run create-admin -- <email> [first name] [last name]');
  process.exit(1);
}
await migrate({ log: () => {} });
const generated = !process.env.ADMIN_PASSWORD;
const password = process.env.ADMIN_PASSWORD ?? crypto.randomBytes(18).toString('base64url');
const problem = await checkPasswordPolicy(password, { email });
if (problem) {
  console.error(`ADMIN_PASSWORD rejected: ${problem}`);
  process.exit(1);
}
const user = await one(
  `INSERT INTO users (email, password_hash, first_name, last_name, role, email_verified_at)
   VALUES (lower($1), $2, $3, $4, 'admin', now())
   ON CONFLICT (email) DO UPDATE SET role = 'admin', password_hash = EXCLUDED.password_hash,
     email_verified_at = coalesce(users.email_verified_at, now()), disabled_at = NULL
   RETURNING id, email`,
  [email, await hashPassword(password), first, last],
);
console.log(`Admin ready: ${user.email}`);
if (generated) console.log(`Temporary password (shown once): ${password}`);
console.log('On first sign-in you will be asked to set up two-step verification.');
await pool.end();
