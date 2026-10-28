import crypto from 'node:crypto';
import { config } from '../config.js';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// ---------- Encryption at rest ----------
// Design:
// - One master key (ENCRYPTION_KEY), plus optional retired keys (ENCRYPTION_KEYS_PREVIOUS) so a key
//   can be rotated without downtime: new data uses the current key, old data stays readable until
//   `npm run rotate-keys` re-encrypts it.
// - Each use ("purpose") gets its own sub-key derived with HKDF, so MFA secrets and ID images are
//   never encrypted under the same key.
// - AES-256-GCM with associated data binding each ciphertext to its record (e.g. the attempt and
//   media kind). A ciphertext copied into another row fails to decrypt instead of being accepted.

const keyId = (master) => crypto.createHash('sha256').update(master).digest().subarray(0, 4);
const masters = [config.ENCRYPTION_KEY, ...config.ENCRYPTION_KEYS_PREVIOUS].map((k) => {
  const master = Buffer.from(k, 'base64');
  return { master, id: keyId(master) };
});
const current = masters[0];
const subkeys = new Map();
function subkey(entry, purpose) {
  const cacheKey = `${entry.id.toString('hex')}:${purpose}`;
  if (!subkeys.has(cacheKey)) {
    subkeys.set(cacheKey, Buffer.from(crypto.hkdfSync('sha256', entry.master, 'high-vault-lms', `purpose:${purpose}`, 32)));
  }
  return subkeys.get(cacheKey);
}
const findKey = (id) => masters.find((m) => m.id.equals(id));

const VERSION = 0x02;
const aadFor = (purpose, context) => Buffer.from(`${purpose}|${context ?? ''}`);

/** Encrypts a buffer. Layout: version(1) | keyId(4) | iv(12) | tag(16) | ciphertext. */
export function encryptBuffer(buf, { purpose, context } = {}) {
  if (!purpose) throw new Error('encryptBuffer needs a purpose');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', subkey(current, purpose), iv);
  cipher.setAAD(aadFor(purpose, context));
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), current.id, iv, cipher.getAuthTag(), ct]);
}

export function decryptBuffer(payload, { purpose, context } = {}) {
  if (payload[0] !== VERSION) return legacyDecryptBuffer(payload);
  const entry = findKey(payload.subarray(1, 5));
  if (!entry) throw new Error('Encrypted with an unknown key. Add the old key to ENCRYPTION_KEYS_PREVIOUS.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', subkey(entry, purpose), payload.subarray(5, 17));
  decipher.setAAD(aadFor(purpose, context));
  decipher.setAuthTag(payload.subarray(17, 33));
  return Buffer.concat([decipher.update(payload.subarray(33)), decipher.final()]);
}

/** Text variant, stored as "v2.<base64url>". */
export function encrypt(plaintext, opts) {
  return `v2.${encryptBuffer(Buffer.from(plaintext, 'utf8'), opts).toString('base64url')}`;
}

export function decrypt(payload, opts) {
  if (!payload.startsWith('v2.')) return legacyDecrypt(payload);
  return decryptBuffer(Buffer.from(payload.slice(3), 'base64url'), opts).toString('utf8');
}

/** True when a value should be re-encrypted (older key or older format). */
export function needsRotation(payload) {
  const buf = typeof payload === 'string' ? (payload.startsWith('v2.') ? Buffer.from(payload.slice(3), 'base64url') : null) : payload;
  return !buf || buf[0] !== VERSION || !buf.subarray(1, 5).equals(current.id);
}

// Format used before key versioning (iv.tag.ct with the raw master key). Read-only.
function legacyDecrypt(payload) {
  const [iv, tag, ct] = payload.split('.').map((p) => Buffer.from(p, 'base64url'));
  return legacyOpen(iv, tag, ct).toString('utf8');
}
function legacyDecryptBuffer(payload) {
  return legacyOpen(payload.subarray(0, 12), payload.subarray(12, 28), payload.subarray(28));
}
function legacyOpen(iv, tag, ct) {
  for (const { master } of masters) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', master, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      /* try the next key */
    }
  }
  throw new Error('Unable to decrypt legacy value');
}

// Unambiguous alphabet (no 0/O, 1/I/L) so codes can be read over the phone.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function certificateCode(date = new Date()) {
  const pick = (n) => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  return `HV-${date.getUTCFullYear()}-${pick(4)}-${pick(4)}`;
}

/** Unbiased Fisher–Yates shuffle using a CSPRNG. */
export function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
