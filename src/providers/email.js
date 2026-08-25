/**
 * Email provider - used for account verification codes.
 *
 * Three backends, chosen by what is configured:
 *   1. Resend    (RESEND_API_KEY)  - recommended; an HTTP API, so there are no
 *                                    SMTP ports to open and it works on hosts
 *                                    that block outbound 587.
 *   2. SMTP      (SMTP_HOST)       - any classic mail server.
 *   3. Console   (nothing set)     - codes are logged, not sent. Fine locally
 *                                    and in tests; in production it means
 *                                    nobody can verify an account, so
 *                                    /health reports it as dry-run.
 */
import config from '../config/index.js';

export const sentEmails = [];

/** True when nothing is configured, so mail is logged instead of sent. */
export const isDryRun = () => !config.resend.apiKey && !config.smtp.host;

/** Which backend is actually in use - surfaced in /health and Settings. */
export const activeProvider = () => {
  if (config.resend.apiKey) return 'resend';
  if (config.smtp.host) return 'smtp';
  return 'console';
};

let resendClient = null;
let transporter = null;

/* ------------------------------------------------------------------ *
 * Backends - each built lazily, so an unused one is never imported.
 * ------------------------------------------------------------------ */

const resendProvider = {
  name: 'resend',
  async send({ to, subject, text, html }) {
    if (!resendClient) {
      const { Resend } = await import('resend');
      resendClient = new Resend(config.resend.apiKey);
    }
    const { data, error } = await resendClient.emails.send({
      from: config.resend.from,
      to: [to],
      subject,
      text,
      html,
    });
    // The SDK reports failures in `error` rather than throwing.
    if (error) throw new Error(error.message || 'Resend rejected the message');
    return { success: true, messageId: data?.id };
  },
};

const smtpProvider = {
  name: 'smtp',
  async send({ to, subject, text, html }) {
    if (!transporter) {
      const nodemailer = (await import('nodemailer')).default;
      transporter = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        // Some relays (and local test servers) accept unauthenticated mail.
        auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
        tls: { rejectUnauthorized: config.smtp.rejectUnauthorized },
      });
    }
    const info = await transporter.sendMail({ from: config.smtp.from, to, subject, text, html });
    return { success: true, messageId: info.messageId };
  },
};

export const consoleEmailProvider = {
  name: 'console',
  async send({ to, subject, text }) {
    if (config.env !== 'test') {
      console.log(`[email] to=${to} subject="${subject}"
${text}`);
    }
    return { success: true };
  },
};

const BACKENDS = {
  resend: resendProvider,
  smtp: smtpProvider,
  console: consoleEmailProvider,
};

export async function send(message) {
  // Always keep a local record - the simulator and tests read it.
  sentEmails.push({ ...message, at: new Date() });
  return BACKENDS[activeProvider()].send(message);
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
