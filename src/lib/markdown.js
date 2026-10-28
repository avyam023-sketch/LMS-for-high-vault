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
