import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

/** Renders admin-authored Markdown to HTML with a strict allow-list. */
export function renderMarkdown(md = '') {
  const html = marked.parse(md, { async: false, gfm: true });
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2']),
    allowedAttributes: { a: ['href', 'title'], img: ['src', 'alt', 'title'], '*': [] },
    allowedSchemes: ['https', 'mailto'],
    allowedSchemesByTag: { img: ['https'] },
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }) },
  });
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
