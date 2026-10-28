import nodemailer from 'nodemailer';
import { config } from '../config.js';

// Email delivery. Resend's HTTP API when RESEND_API_KEY is set (recommended), any SMTP server
// when SMTP_URL is set, otherwise messages are kept in `outbox` and printed (development/tests).
const smtp = !config.RESEND_API_KEY && config.SMTP_URL ? nodemailer.createTransport(config.SMTP_URL) : null;

/** Messages captured when no email service is configured (dev/test). */
export const outbox = [];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Branded, table-based HTML that renders the same in Gmail, Outlook and Apple Mail. */
function layout({ heading, body, code, action, details, footer }) {
  const rows = (details ?? [])
    .map(([label, value]) => `<tr><td style="padding:8px 0;color:#6d5f62;font-size:13px;width:150px;vertical-align:top">${esc(label)}</td>
      <td style="padding:8px 0;font-size:14px;font-family:'IBM Plex Mono',Menlo,Consolas,monospace;color:#241517">${esc(value)}</td></tr>`)
    .join('');
  const button = action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 8px"><tr><td style="background:#a3162c;border-radius:4px">
         <a href="${esc(action.url)}" style="display:inline-block;padding:13px 24px;color:#ffffff;font-weight:600;font-size:15px;text-decoration:none">${esc(action.label)}</a>
       </td></tr></table>
       <p style="font-size:12px;color:#6d5f62;margin:12px 0 0;word-break:break-all">Or paste this link into your browser: ${esc(action.url)}</p>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#faf7f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf7f6;padding:32px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #eee3e4;border-radius:6px;font-family:Arial,Helvetica,sans-serif;color:#241517">
    <tr><td style="background:#a3162c;padding:20px 28px;border-radius:6px 6px 0 0">
      <span style="color:#ffffff;font-size:13px;letter-spacing:.14em">THE HIGH VAULT SECURITY</span>
      <span style="color:#f6d6dc;font-size:11px;letter-spacing:.1em;padding-left:10px">FOOD HANDLER CERTIFICATION</span>
    </td></tr>
    <tr><td style="padding:32px 28px 28px">
      <h1 style="font-size:22px;line-height:1.3;font-weight:600;margin:0 0 16px">${esc(heading)}</h1>
      ${body.map((p) => `<p style="font-size:15px;line-height:1.6;margin:0 0 14px">${esc(p)}</p>`).join('')}
      ${code ? `<p style="margin:22px 0 6px;font-family:'IBM Plex Mono',Menlo,Consolas,monospace;font-size:34px;letter-spacing:.3em;font-weight:600;color:#241517">${esc(code)}</p>` : ''}
      ${rows ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:20px 0 4px;border-top:1px solid #eee3e4;border-bottom:1px solid #eee3e4">${rows}</table>` : ''}
      ${button}
    </td></tr>
    <tr><td style="padding:18px 28px;border-top:1px solid #eee3e4;font-size:12px;line-height:1.6;color:#6d5f62">
      ${esc(footer ?? `Questions? Email ${config.SUPPORT_EMAIL} and quote the reference above.`)}<br>
      The High Vault Security · <a href="${esc(config.appUrl)}" style="color:#a3162c">${esc(config.appUrl.replace(/^https?:\/\//, ''))}</a>
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

function plainText({ heading, body, code, action, details, footer }) {
  return [
    heading, '',
    ...body,
    ...(code ? ['', code] : []),
    ...(details?.length ? ['', ...details.map(([l, v]) => `${l}: ${v}`)] : []),
    ...(action ? ['', `${action.label}: ${action.url}`] : []),
    '', footer ?? `Questions? Email ${config.SUPPORT_EMAIL} and quote the reference above.`,
  ].join('\n');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resend's HTTP API. Retries rate limits and server errors; the idempotency key stops duplicates. */
async function sendWithResend(message, { idempotencyKey, category }) {
  const payload = {
    from: message.from,
    to: [message.to],
    subject: message.subject,
    html: message.html,
    text: message.text,
    ...(config.SUPPORT_EMAIL ? { reply_to: [config.SUPPORT_EMAIL] } : {}),
    ...(category ? { tags: [{ name: 'category', value: category.replace(/[^\w-]/g, '_') }] } : {}),
  };
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey.slice(0, 256) } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      if (attempt >= 4) throw err;
      await wait(500 * 2 ** attempt);
      continue;
    }
    if (res.ok) return;
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const retryAfter = Number(res.headers.get('retry-after')) * 1000;
      await wait(retryAfter > 0 ? Math.min(retryAfter, 10_000) : 500 * 2 ** attempt);
      continue;
    }
    // A repeat of an already-sent message (same idempotency key) is not a failure.
    if (res.status === 409 && idempotencyKey) return;
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
  }
}

/**
 * Sends one email. Never throws: a failed email is logged and reported as false, so it can't break
 * the page that triggered it. `idempotencyKey` (e.g. "exam-result/<id>") makes retries safe.
 */
// Reserved for examples (RFC 2606), so never deliverable. Sample learners use them; sending would only bounce
// and hurt the sending domain's reputation.
const UNDELIVERABLE = /@(?:(?:[^@]+\.)?example\.(?:com|net|org)|[^@]+\.(?:test|example|invalid|localhost))$/i;

// While sample data loads (at boot, before the server listens) its exams would otherwise email the real admin.
let muted = false;
export async function withoutEmail(fn) {
  muted = true;
  try {
    return await fn();
  } finally {
    muted = false;
  }
}

export async function sendMail({ to, subject, heading, body, code, action, details, footer, idempotencyKey, category }) {
  const parts = { heading, body, code, action, details, footer };
  const message = { from: config.MAIL_FROM, to, subject, text: plainText(parts), html: layout(parts), category };
  try {
    if (muted) return true;
    if ((config.RESEND_API_KEY || smtp) && UNDELIVERABLE.test(to)) console.log(`[mail] not sent to example address ${to}: "${subject}"`);
    else if (config.RESEND_API_KEY) await sendWithResend(message, { idempotencyKey, category });
    else if (smtp) await smtp.sendMail(message);
    else {
      outbox.push(message);
      if (!config.isTest) console.log(`[mail] to=${to} subject="${subject}"\n${message.text}\n`);
    }
    return true;
  } catch (err) {
    console.error(`[mail] failed: subject="${subject}" category=${category ?? '-'}: ${err.message}`);
    return false;
  }
}
