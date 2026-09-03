import dotenv from 'dotenv';
dotenv.config();

const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 4000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:4000',

  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/mynanny',

  jwtSecret: process.env.JWT_SECRET || 'dev-secret',
  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@mynanny.com',
    password: process.env.ADMIN_PASSWORD || 'admin123',
  },

  ultramsg: {
    instanceId: process.env.ULTRAMSG_INSTANCE_ID || '',
    token: process.env.ULTRAMSG_TOKEN || '',
    baseUrl: process.env.ULTRAMSG_BASE_URL || 'https://api.ultramsg.com',
    webhookToken: process.env.ULTRAMSG_WEBHOOK_TOKEN || '',
  },

  // Resend is the preferred mail backend: an HTTP API, so nothing depends on
  // outbound SMTP ports being open. Falls back to SMTP, then console logging.
  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
    from: process.env.RESEND_FROM || 'My Nanny <onboarding@resend.dev>',
    // Where replies go. Safe to be a normal inbox — only the From
    // address has to belong to a verified domain.
    replyTo: process.env.RESEND_REPLY_TO || '',
  },

  // SMTP for verification codes. Without a host we fall back to console
  // logging, which is fine locally but must be configured in production.
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'My Nanny <no-reply@localhost>',
    // Some relays present self-signed certs. Opt out of verification
    // explicitly rather than silently trusting every certificate.
    rejectUnauthorized: String(process.env.SMTP_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false',
  },

  // How far ahead a booking may be made. A start date beyond a few months is
  // almost always a typo (a wrong year), and an end date years out would
  // generate service days indefinitely.
  booking: {
    maxStartMonths: int(process.env.BOOKING_MAX_START_MONTHS, 3),
    maxDurationMonths: int(process.env.BOOKING_MAX_DURATION_MONTHS, 12),
  },

  // The thank-you for referring someone: they pay the discounted rate
  // instead of the standard one. Shown as typed, so "90k" stays "90k".
  referral: {
    // Referral links are read aloud and retyped, so they can point at a
    // short domain instead of the long hosting URL.
    linkBase: process.env.REFERRAL_LINK_BASE || '',
    standardRate: process.env.REFERRAL_STANDARD_RATE || '120k',
    discountedRate: process.env.REFERRAL_DISCOUNTED_RATE || '90k',
  },

  // Bank details the bot shows families so they can make the transfer.
  bank: {
    name: process.env.BANK_NAME || '',
    accountName: process.env.BANK_ACCOUNT_NAME || '',
    accountNumber: process.env.BANK_ACCOUNT_NUMBER || '',
    iban: process.env.BANK_IBAN || '',
    instructions: process.env.BANK_INSTRUCTIONS || '',
  },

  currency: process.env.CURRENCY || 'IDR',
  transportFee: {
    min: int(process.env.TRANSPORT_FEE_MIN, 50000),
    max: int(process.env.TRANSPORT_FEE_MAX, 100000),
  },

  // Response windows (spec: 1h new booking, 2h existing booking change)
  newBookingResponseMinutes: int(process.env.NEW_BOOKING_RESPONSE_MINUTES, 60),
  changeBookingResponseMinutes: int(process.env.CHANGE_BOOKING_RESPONSE_MINUTES, 120),

  reschedulePenaltyPercent: int(process.env.RESCHEDULE_PENALTY_PERCENT, 5),
  freeRescheduleLimit: int(process.env.FREE_RESCHEDULE_LIMIT, 3),
  liveLocationWindowHours: int(process.env.LIVE_LOCATION_WINDOW_HOURS, 2),
};

export default config;
