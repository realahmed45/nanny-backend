/**
 * Email provider abstraction (verification codes, receipts).
 *
 * The console provider prints the message; in dev the OTP is also surfaced in
 * the WhatsApp reply so the flow can be exercised end-to-end without SMTP.
 * Swap in nodemailer/SES here to go live.
 */
import config from '../config/index.js';

export const sentEmails = [];

export const consoleEmailProvider = {
  name: 'console',
  async send({ to, subject, text }) {
    sentEmails.push({ to, subject, text, at: new Date() });
    if (config.env !== 'test') {
      console.log(`[email] to=${to} subject="${subject}"\n${text}`);
    }
    return { success: true };
  },
};

export const emailProvider = consoleEmailProvider;

export async function sendVerificationCode(to, code) {
  return emailProvider.send({
    to,
    subject: 'My Nanny — Your verification code',
    text: `Your My Nanny verification code is ${code}. It expires in 10 minutes.`,
  });
}

export default emailProvider;
