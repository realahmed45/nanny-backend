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

/**
 * Free mailbox providers publish DNS records that forbid anyone else sending
 * as them, so a gmail.com / outlook.com sender is rejected or lands in spam no
 * matter which service is used. Catching it here names the real problem
 * instead of leaving a confusing provider error.
 */
const PUBLIC_MAILBOX = /@(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|aol|proton(mail)?)\./i;

const senderAddress = (from) => {
  const match = /<([^>]+)>/.exec(from || '');
  return (match ? match[1] : from || '').trim();
};

const resendProvider = {
  name: 'resend',
  async send({ to, subject, text, html, attachments }) {
    const address = senderAddress(config.resend.from);

    if (PUBLIC_MAILBOX.test(address)) {
      throw new Error(
        `RESEND_FROM is set to ${address}. Email cannot be sent from a free mailbox address `
        + '— use an address on a domain you have verified in Resend, e.g. '
        + 'no-reply@yourdomain.com. Set a Reply-To if you want replies to reach your inbox.',
      );
    }

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
      // Replies reach a real person rather than a no-reply mailbox.
      ...(config.resend.replyTo ? { reply_to: config.resend.replyTo } : {}),
      // Resend takes base64 content; nodemailer takes the buffer directly.
      ...(attachments?.length
        ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64') })) }
        : {}),
    });

    // The SDK reports failures in `error` rather than throwing.
    if (error) throw new Error(error.message || 'Resend rejected the message');
    return { success: true, messageId: data?.id };
  },
};

const smtpProvider = {
  name: 'smtp',
  async send({ to, subject, text, html, attachments }) {
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
    const info = await transporter.sendMail({
      from: config.smtp.from, to, subject, text, html, attachments,
    });
    return { success: true, messageId: info.messageId };
  },
};

export const consoleEmailProvider = {
  name: 'console',
  async send({ to, subject, text, attachments }) {
    if (config.env !== 'test') {
      const files = attachments?.length
        ? ` attachments=${attachments.map((a) => `${a.filename} (${a.content.length} bytes)`).join(', ')}`
        : '';
      console.log(`[email] to=${to} subject="${subject}"${files}
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

/**
 * The masthead every email opens with.
 *
 * Mail clients block remote images by default, so the wordmark is real text
 * beside the logo rather than baked into it: with images off the email still
 * reads as ours. The logo needs a publicly reachable URL — set BRAND_LOGO_URL;
 * without one the wordmark simply stands alone, which is why this degrades
 * quietly instead of showing a broken image.
 */
const header = () => {
  const logo = config.brand.logoUrl
    ? `<img src="${config.brand.logoUrl}" alt="" width="56" height="56"
         style="display:block;border:0;border-radius:50%;background:#fdfcf3">`
    : '';
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 20px">
    <tr>
      ${logo ? `<td style="padding-right:12px;vertical-align:middle">${logo}</td>` : ''}
      <td style="vertical-align:middle">
        <div style="font-size:19px;font-weight:700;color:#111;letter-spacing:.5px">${config.brand.name}</div>
      </td>
    </tr>
  </table>`;
};

const footer = () => `
  <p style="color:#999;font-size:12px;margin-top:28px;border-top:1px solid #eee;padding-top:14px">
    ${config.brand.name}
  </p>`;

const CODE_TEMPLATE = (code) => `
  <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px">
    ${header()}
    <p style="margin:0 0 20px;color:#666;font-size:14px">Account verification</p>
    <p style="color:#333;font-size:15px">Use this code to verify your account:</p>
    <p style="font-size:32px;font-weight:700;letter-spacing:6px;color:#2563eb;margin:16px 0">${code}</p>
    <p style="color:#666;font-size:13px">This code expires in 10 minutes.</p>
    <p style="color:#999;font-size:12px;margin-top:24px">
      If you didn't request this, you can ignore this email.
    </p>
    ${footer()}
  </div>
`;

/** Wrap arbitrary body HTML in the same masthead, for non-code emails. */
export const brandedEmail = (bodyHtml) => `
  <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px">
    ${header()}
    ${bodyHtml}
    ${footer()}
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
