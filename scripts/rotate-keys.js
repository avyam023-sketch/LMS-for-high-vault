// Re-encrypts every stored secret with the current ENCRYPTION_KEY.
// Rotation: 1) move the old key into ENCRYPTION_KEYS_PREVIOUS and set a new ENCRYPTION_KEY,
// 2) deploy, 3) run `npm run rotate-keys`, 4) remove the old key from ENCRYPTION_KEYS_PREVIOUS.
import { pool } from '../src/db/pool.js';
import { decrypt, decryptBuffer, encrypt, encryptBuffer, needsRotation } from '../src/lib/crypto.js';

let mfa = 0;
let media = 0;
const users = await pool.query('SELECT id, mfa_secret_enc FROM users WHERE mfa_secret_enc IS NOT NULL');
for (const u of users.rows) {
  if (!needsRotation(u.mfa_secret_enc)) continue;
  const ctx = { purpose: 'mfa', context: u.id };
  await pool.query('UPDATE users SET mfa_secret_enc = $2 WHERE id = $1', [u.id, encrypt(decrypt(u.mfa_secret_enc, ctx), ctx)]);
  mfa++;
}
// Media can be large: walk it one row at a time.
const ids = await pool.query('SELECT id FROM proctor_media');
for (const { id } of ids.rows) {
  const { rows } = await pool.query('SELECT id, attempt_id, kind, data FROM proctor_media WHERE id = $1', [id]);
  const row = rows[0];
  if (!row || !needsRotation(row.data)) continue;
  const ctx = { purpose: 'proctor-media', context: `${row.attempt_id}:${row.kind}` };
  await pool.query('UPDATE proctor_media SET data = $2 WHERE id = $1', [row.id, encryptBuffer(decryptBuffer(row.data, ctx), ctx)]);
  media++;
}
console.log(`Re-encrypted ${mfa} MFA secret(s) and ${media} proctoring file(s) with the current key.`);
await pool.end();
