import nodemailer from 'nodemailer';
import { config } from '../config.js';

const transport = config.SMTP_URL ? nodemailer.createTransport(config.SMTP_URL) : null;

/** Messages captured when no SMTP server is configured (dev/test). */
export const outbox = [];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function layout({ heading, body, action }) {
  const button = action
    ? `<p style="margin:28px 0"><a href="${esc(action.url)}" style="background:#B0D7E4;color:#231F20;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:600">${esc(action.label)}</a></p>
       <p style="font-size:13px;color:#666">Or paste this link into your browser:<br>${esc(action.url)}</p>`
    : '';
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#231F20">
    <div style="background:#231F20;color:#B0D7E4;padding:18px 24px;letter-spacing:.12em;font-size:14px">THE HIGH VAULT SECURITY ACADEMY</div>
    <div style="padding:24px"><h1 style="font-size:20px">${esc(heading)}</h1>${body.map((p) => `<p>${esc(p)}</p>`).join('')}${button}</div></div>`;
}

export async function sendMail({ to, subject, heading, body, action }) {
  const text = [heading, '', ...body, action ? `\n${action.label}: ${action.url}` : ''].join('\n');
  const message = { from: config.MAIL_FROM, to, subject, text, html: layout({ heading, body, action }) };
  if (!transport) {
    outbox.push(message);
    if (!config.isTest) console.log(`[mail] to=${to} subject="${subject}"\n${text}\n`);
    return;
  }
  await transport.sendMail(message);
}
