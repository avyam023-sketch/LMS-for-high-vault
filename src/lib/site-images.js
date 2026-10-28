// Image slots on the public site. Admins upload a photo for each slot in Admin → Site images;
// until then the page shows a branded placeholder of the same shape, so the layout never jumps.
import { many, one, query } from '../db/pool.js';

export const SLOTS = [
  { key: 'home-audience-1', label: 'Who it’s for: cooks', where: 'Homepage, “Who it’s for” (left)', ratio: '4:5', size: '1200 × 1500', icon: 'users',
    suggestion: 'A cook at work in a clean commercial kitchen.' },
  { key: 'home-audience-2', label: 'Who it’s for: servers and baristas', where: 'Homepage, “Who it’s for” (middle)', ratio: '4:5', size: '1200 × 1500', icon: 'users',
    suggestion: 'A server or barista behind a café counter.' },
  { key: 'home-audience-3', label: 'Who it’s for: prep, catering and owners', where: 'Homepage, “Who it’s for” (right)', ratio: '4:5', size: '1200 × 1500', icon: 'users',
    suggestion: 'Food prep with gloves, or an owner in their kitchen.' },
  { key: 'home-study', label: 'Studying from home', where: 'Homepage, “What you need”', ratio: '3:2', size: '1600 × 1067', icon: 'devices',
    suggestion: 'Someone studying on a laptop at home.' },
  { key: 'about-story', label: 'About: our story', where: 'About page, “Why we built it”', ratio: '3:2', size: '1600 × 1067', icon: 'book',
    suggestion: 'A busy, well-run kitchen or a team at work.' },
  { key: 'signup-aside', label: 'Sign-up page', where: 'Register and sign-in pages, left panel', ratio: '4:5', size: '1200 × 1500', icon: 'shield',
    suggestion: 'Hands being washed, or a chef checking a thermometer.' },
];
export const SLOT_KEYS = new Set(SLOTS.map((s) => s.key));
export const MAX_BYTES = 4 * 1024 * 1024;

/** Reads width and height from the file itself (JPEG, PNG or WebP), and confirms the type matches. */
export function imageInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32) return null;
  // PNG: signature, then IHDR width/height.
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: walk the markers to the first start-of-frame.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { mime: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  // WebP: RIFF container with a VP8 (lossy), VP8L (lossless) or VP8X (extended) chunk.
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') return { mime: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { mime: 'image/webp', width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  return null;
}

// The slot list is read on most public pages, so keep it in memory. It's refreshed on every change,
// and at least once a minute in case another app instance made the change.
let cache = null;
let cachedAt = 0;
export async function siteImages() {
  if (!cache || Date.now() - cachedAt > 60_000) {
    cachedAt = Date.now();
    const rows = await many('SELECT slot, width, height, alt, updated_at FROM site_images');
    cache = new Map(rows.map((r) => [r.slot, { ...r, url: `/site-images/${r.slot}?v=${new Date(r.updated_at).getTime().toString(36)}` }]));
  }
  return cache;
}
export const forgetSiteImages = () => { cache = null; };

export async function saveSiteImage(slot, buf, { alt, userId }) {
  const info = imageInfo(buf);
  if (!info || !info.width || !info.height) return { error: 'That file isn’t a JPEG, PNG or WebP image.' };
  if (buf.length > MAX_BYTES) return { error: 'That image is larger than 4 MB. Export it at about 1600 pixels wide and try again.' };
  if (info.width < 600) return { error: `That image is only ${info.width} pixels wide. Use one at least 1200 pixels wide so it looks sharp.` };
  await query(
    `INSERT INTO site_images (slot, mime, data, byte_size, width, height, alt, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (slot) DO UPDATE SET mime = $2, data = $3, byte_size = $4, width = $5, height = $6,
       alt = CASE WHEN $7 = '' THEN site_images.alt ELSE $7 END, updated_by = $8, updated_at = now()`,
    [slot, info.mime, buf, buf.length, info.width, info.height, alt ?? '', userId],
  );
  forgetSiteImages();
  return { info };
}

export async function siteImageFile(slot) {
  return one('SELECT mime, data, updated_at FROM site_images WHERE slot = $1', [slot]);
}
