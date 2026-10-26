import argon2 from 'argon2';
import crypto from 'node:crypto';
import { config } from '../config.js';

// Argon2id — OWASP's first-choice password hashing algorithm.
const OPTIONS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 };

export const hashPassword = (password) => argon2.hash(password, OPTIONS);

export async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

// A real hash so that "unknown email" logins take as long as "wrong password".
let dummyHash;
export async function burnTime(password) {
  dummyHash ??= await hashPassword(crypto.randomBytes(16).toString('hex'));
  await verifyPassword(dummyHash, password);
}

const COMMON = new Set([
  'password1234', 'password12345', 'password123456', 'qwertyuiop12', '123456789012', 'iloveyou1234',
  'welcome12345', 'letmein12345', 'administrator', 'securityguard', 'highvaultsecurity', 'changeme1234',
]);

/** Returns an error message, or null when the password is acceptable. */
export async function checkPasswordPolicy(password, { email = '', name = '' } = {}) {
  if (password.length < 12) return 'Use at least 12 characters. A short phrase works well.';
  if (password.length > 128) return 'Use 128 characters or fewer.';
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) return 'That password is too common. Choose another.';
  const local = email.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return 'Your password should not contain your email.';
  if (name && name.length >= 4 && lower.includes(name.toLowerCase())) return 'Your password should not contain your name.';
  if (config.CHECK_BREACHED_PASSWORDS && (await isBreached(password))) {
    return 'This password has appeared in a known data breach. Choose a different one.';
  }
  return null;
}

/** Have I Been Pwned k-anonymity check: only the first 5 hash characters leave the server. */
async function isBreached(password) {
  const hash = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const body = await res.text();
    return body.split('\n').some((line) => line.startsWith(hash.slice(5)) && !line.endsWith(':0'));
  } catch {
    return false; // Fail open: an outage should not block registration.
  }
}
