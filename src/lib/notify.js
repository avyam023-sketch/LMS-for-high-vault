import { config } from '../config.js';
import { sendMail } from './mailer.js';

const WHEN = () => new Date().toLocaleString('en-CA', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Toronto' });

/** Tells a user about a security-relevant change to their account, so they can react if it wasn't them. */
export async function securityNotice(user, change, ip) {
  try {
    await sendMail({
      to: user.email,
      subject: `Security alert: ${change.toLowerCase()} — The High Vault Security`,
      heading: change,
      body: [
        `This happened on ${WHEN()} (Toronto time)${ip ? ` from IP address ${ip}` : ''}.`,
        'If this was you, no action is needed.',
        `If it wasn’t, reset your password now and contact ${config.SUPPORT_EMAIL}.`,
      ],
      action: { label: 'Reset your password', url: `${config.appUrl}/forgot-password` },
    });
  } catch (err) {
    console.error('security notice failed', err);
  }
}
