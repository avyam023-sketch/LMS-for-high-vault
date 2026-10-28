import crypto from 'node:crypto';
import { config } from '../config.js';

// Chapter videos. Bunny Stream is the recommended host: playback is token-signed (links expire and
// can't be shared) and its player reports progress, so learners must watch to the end.
// A direct .mp4/.webm link is also tracked; YouTube and Vimeo links play but can't be tracked.

const BUNNY_HOSTS = new Set(['iframe.mediadelivery.net', 'player.mediadelivery.net']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Long enough to watch a chapter with breaks; short enough that a copied link soon stops working.
const SIGNED_HOURS = 6;

/** Library and video IDs from a Bunny Stream embed or play link, e.g. https://iframe.mediadelivery.net/embed/123/<uuid>. */
export function parseBunny(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !BUNNY_HOSTS.has(u.hostname)) return null;
    const [, kind, libraryId, videoId] = u.pathname.split('/');
    if (!['embed', 'play'].includes(kind) || !/^\d{1,10}$/.test(libraryId ?? '') || !UUID.test(videoId ?? '')) return null;
    return { host: u.hostname, libraryId, videoId: videoId.toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * Bunny's embed token: SHA-256 (hex) of token key + video ID + expiry (Unix seconds).
 * Without a key the link is unsigned, which only plays if token authentication is off for the library.
 */
export function bunnyEmbedUrl({ host, libraryId, videoId }, { key = config.BUNNY_STREAM_TOKEN_KEY, now = Date.now() } = {}) {
  const url = new URL(`https://${host}/embed/${libraryId}/${videoId}`);
  if (key) {
    const expires = Math.floor(now / 1000) + SIGNED_HOURS * 3600;
    url.searchParams.set('token', crypto.createHash('sha256').update(key + videoId + expires).digest('hex'));
    url.searchParams.set('expires', String(expires));
  }
  url.searchParams.set('autoplay', 'false');
  url.searchParams.set('preload', 'true');
  url.searchParams.set('responsive', 'true');
  return url.href;
}

/**
 * How to play a lesson video:
 *   { kind: 'bunny', src }  Bunny Stream iframe, signed, progress tracked through player.js
 *   { kind: 'file', src }   direct video file, played natively and tracked
 *   { kind: 'embed', src }  YouTube or Vimeo, not tracked
 * or null when there's no usable video.
 */
export function videoSource(url) {
  if (!url) return null;
  const bunny = parseBunny(url);
  if (bunny) return { kind: 'bunny', src: bunnyEmbedUrl(bunny) };
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && /\.(mp4|webm|mov|m4v)$/i.test(u.pathname)) return { kind: 'file', src: u.href };
  } catch {
    return null;
  }
  const src = embedUrl(url);
  return src ? { kind: 'embed', src } : null;
}

/** Converts a YouTube/Vimeo URL into a privacy-friendly embed URL, or null. */
export function embedUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(u.pathname.slice(1))}`;
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const id = u.searchParams.get('v') ?? u.pathname.split('/').pop();
      return id ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}` : null;
    }
    if (host === 'vimeo.com') return `https://player.vimeo.com/video/${encodeURIComponent(u.pathname.split('/').pop())}`;
    if (host === 'player.vimeo.com' || host === 'youtube-nocookie.com') return u.href;
  } catch {
    /* invalid URL */
  }
  return null;
}
