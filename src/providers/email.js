/**
 * Email provider — used for account verification codes.
 *
 * With SMTP configured, mail is sent for real over nodemailer. Without it the
 * provider falls back to logging, so local development and the test suite work
 * with no mail server. `isDryRun()` tells the rest of the app which is active,
 * and /health surfaces it, so a misconfigured production deploy is visible
 * rather than silently swallowing verification codes.
 */
import nodemailer from 'nodemailer';
import config from '../config/index.js';

export const sentEmails = [];

/** True when no SMTP host is configured, so mail is logged instead of sent. */
export const isDryRun = () => !config.smtp.host;

let transporter = null;

/** Built lazily so no connection is attempted until the first email. */
function getTransport() {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    // Some relays (and local test servers) accept unauthenticated mail.
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    tls: { rejectUnauthorized: config.smtp.rejectUnauthorized },
  });
  return transporter;
}

export const smtpEmailProvider = {
  name: 'smtp',
  async send({ to, subject, text, html }) {
    const info = await getTransport().sendMail({
      from: config.smtp.from,
      to,
      subject,
      text,
      html,
    });
    return { success: true, messageId: info.messageId };
  },
};

export const consoleEmailProvider = {
  name: 'console',
  async send({ to, subject, text }) {
    if (config.env !== 'test') {
      console.log(`[email] to=${to} subject="${subject}"\n${text}`);
    }
    return { success: true };
  },
};

/** Chosen per call so tests and runtime config changes are honoured. */
function provider() {
  return isDryRun() ? consoleEmailProvider : smtpEmailProvider;
}

export async function send(message) {
  // Always keep a local record — the admin dashboard and tests read it.
  sentEmails.push({ ...message, at: new Date() });
  return provider().send(message);
}

const CODE_TEMPLATE = (code) => `
  <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px">
    <h2 style="margin:0 0 4px;color:#111">My Nanny</h2>
    <p style="margin:0 0 20px;color:#666;font-size:14px">Account verification</p>
    <p style="color:#333;font-size:15px">Use this code to verify your account:</p>
    <p style="font-size:32px;font-weight:700;letter-spacing:6px;color:#2563eb;margin:16px 0">${code}</p>
    <p style="color:#666;font-size:13px">This code expires in 10 minutes.</p>
    <p style="color:#999;font-size:12px;margin-top:24px">
      If you didn't request this, you can ignore this email.
    </p>
  </div>
`;

export async function sendVerificationCode(to, code) {
  return send({
    to,
    subject: 'My Nanny — Your verification code',
    text: `Your My Nanny verification code is ${code}. It expires in 10 minutes.`,
    html: CODE_TEMPLATE(code),
  });
}

export const emailProvider = { name: 'auto', send };
export default emailProvider;
