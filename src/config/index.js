import dotenv from 'dotenv';
dotenv.config();

const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));

const isProduction = (process.env.NODE_ENV || 'development') === 'production';

/**
 * A secret that must never keep its development default in production.
 *
 * `jwtSecret` signs admin sessions and `ADMIN_PASSWORD` opens the dashboard,
 * which holds every family's address and phone number. Both had a convenient
 * fallback — `dev-secret`, `admin123` — that made local work easy and would
 * have silently secured a live server with a password published in this
 * repository if the environment variable were ever missing or misspelled.
 *
 * Locally the fallback stands, because there is nothing to protect and
 * demanding configuration to run the tests helps nobody. In production a
 * missing value stops the process at boot: a server that will not start is a
 * problem someone fixes in minutes, while one running on `admin123` is a
 * breach nobody notices.
 */
function requiredSecret(name, devFallback) {
  const value = process.env[name];
  if (value && value !== devFallback) return value;

  if (isProduction) {
    throw new Error(
      `[config] ${name} is not set (or is still the development default). `
      + 'Refusing to start in production: this secret protects the admin '
      + 'dashboard and every family record in it. Set it and restart.',
    );
  }
  return devFallback;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 4000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:4000',

  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/mynanny',

  jwtSecret: requiredSecret('JWT_SECRET', 'dev-secret'),
  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@mynanny.com',
    password: requiredSecret('ADMIN_PASSWORD', 'admin123'),
    // Guards the email diagnostic. Unset means the endpoint does not exist,
    // so it cannot be probed on a server that never needed it.
    diagKey: process.env.DIAG_KEY || '',
  },

  ultramsg: {
    instanceId: process.env.ULTRAMSG_INSTANCE_ID || '',
    token: process.env.ULTRAMSG_TOKEN || '',
    baseUrl: process.env.ULTRAMSG_BASE_URL || 'https://api.ultramsg.com',
    /**
     * Proves an inbound webhook really came from the provider.
     *
     * Required in production, because the check that uses it is skipped when it
     * is empty — and it was empty. Anyone who found the URL could post a message
     * naming any phone number and the system would treat it as that person:
     * book, cancel, confirm an arrival code, change their details. An open door
     * is worse than a refused start, so this refuses to start.
     */
    webhookToken: requiredSecret('ULTRAMSG_WEBHOOK_TOKEN', ''),
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

  // Speech-to-text for WhatsApp voice notes. Either key enables it; Groq is
  // tried first because its free tier covers this comfortably.
  transcription: {
    groqKey: process.env.GROQ_API_KEY || '',
    openaiKey: process.env.OPENAI_API_KEY || '',
    // Override the endpoint host (used by tests, or behind a proxy).
    baseUrl: process.env.TRANSCRIPTION_BASE_URL || '',
    // Leave empty to let Whisper detect the language, which suits a market
    // where people mix languages in one message.
    language: process.env.TRANSCRIPTION_LANGUAGE || '',
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
    // The number a referral link opens a chat with. Without it the landing
    // page can only ask people to find us themselves, which loses most of them.
    whatsappNumber: (process.env.WHATSAPP_NUMBER || '').replace(/\D/g, ''),
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

  // The platform prices, charges, and pays out in rupiah, and every amount
  // stored is a rupiah figure. A CURRENCY of anything else does not convert
  // those numbers — it just relabels them, so "USD 16,220,000" is a price
  // wrong by a factor of about fifteen thousand. The env var can only pick a
  // currency the code actually supports; anything else is ignored with a warning.
  currency: (() => {
    const want = (process.env.CURRENCY || 'IDR').trim().toUpperCase();
    if (want === 'IDR') return 'IDR';
    console.warn(`[config] CURRENCY=${want} ignored — amounts are stored in rupiah; using IDR.`);
    return 'IDR';
  })(),
  /**
   * The timezone the business actually operates in.
   *
   * Every service time, every period boundary and every cron hour used to be
   * computed in whatever zone the host happened to run in. On a hosted server
   * that is UTC, and Bali is UTC+8, so a 09:00 booking was stored as 09:00Z and
   * shown to the nanny as 5:00 PM — the same booking reading two different times
   * on one screen. Fixed here rather than by hoping TZ is set on the host, so it
   * cannot silently differ between a laptop and production.
   */
  timezone: (process.env.BUSINESS_TZ || 'Asia/Makassar').trim(),

  transportFee: {
    min: int(process.env.TRANSPORT_FEE_MIN, 50000),
    max: int(process.env.TRANSPORT_FEE_MAX, 100000),
  },

  /**
   * What an emergency costs on top.
   *
   * A same-day request pulls a nanny across town at no notice, so the
   * transport fee rises by a flat amount rather than a percentage: 50,000
   * becomes 100,000, 100,000 becomes 150,000. Paid to the nanny in cash when
   * she arrives, not taken through the platform — which is why it is quoted
   * everywhere but never added to the amount the family transfers.
   */
  emergencySurcharge: int(process.env.EMERGENCY_SURCHARGE, 50000),

  /**
   * Paid to a nanny on top of her hourly rate for taking an emergency, in
   * recognition of dropping everything at an hour's notice. Quoted in the
   * broadcast, because a nanny deciding in thirty seconds needs to know what
   * the job is worth.
   */
  emergencyHourlyBonus: int(process.env.EMERGENCY_HOURLY_BONUS, 15000),

  /**
   * How many days of silence before a half-finished conversation is dropped
   * and the next message starts cleanly. Long enough not to interrupt a real
   * pause, short enough that nobody resumes a form from last season.
   */
  staleSessionDays: int(process.env.STALE_SESSION_DAYS, 30),

  /**
   * Show this number instead of the real one, everywhere in the dashboard.
   *
   * For demos and seeded data: the database keeps genuine per-person numbers,
   * because the bot finds people by looking theirs up and a shared one would
   * match hundreds of accounts at random. Only the display is replaced.
   *
   * Unset in production, where the real number is the whole point.
   */
  displayPhoneOverride: process.env.DISPLAY_PHONE_OVERRIDE || '',

  /**
   * Understanding what people meant, when the strict parser could not.
   *
   * Shares GROQ_API_KEY with voice transcription — one account, one key, and
   * the free tier covers both comfortably. Switched on per-installation from
   * the dashboard rather than by the key alone, so the key can be present for
   * transcription while flexible replies stay off.
   */
  ai: {
    key: process.env.GROQ_API_KEY || '',
    // Groq retired llama-3.3-70b-versatile in August 2026; every call to it
    // now returns 404 model_not_found, which is invisible from the outside
    // because a failed call just falls back to the strict parser. This is
    // their named replacement, and it stays overridable so the next
    // retirement is an environment variable rather than a deploy.
    model: process.env.AI_MODEL || 'openai/gpt-oss-120b',
  },

  /**
   * Our own copy of every photo and video a nanny sends.
   *
   * Without this the profiles point at files on the WhatsApp provider's
   * servers, which we do not own and cannot stop being deleted. MEDIA_DIR must
   * be on persistent storage and included in the server's backups — it is the
   * only copy we have.
   */
  media: {
    enabled: process.env.MEDIA_ARCHIVE !== 'off',
    dir: process.env.MEDIA_DIR || 'storage/media',
    maxBytes: int(process.env.MEDIA_MAX_BYTES, 64 * 1024 * 1024),

    /**
     * Where the files actually live, permanently.
     *
     * The directory above is a fallback for local development. In production
     * it is inside the app directory, which Render and most container hosts
     * replace on every deploy — so anything left there is destroyed, and the
     * profiles pointing at it break with nothing to recover from.
     *
     * Set these and the archive moves to object storage instead: R2, B2,
     * Wasabi or S3, all the same API. `publicBase` is the domain files are
     * served from, which is not the endpoint they are uploaded to.
     */
    s3: {
      bucket: process.env.MEDIA_S3_BUCKET || '',
      endpoint: process.env.MEDIA_S3_ENDPOINT || '',
      accessKeyId: process.env.MEDIA_S3_KEY || '',
      secretAccessKey: process.env.MEDIA_S3_SECRET || '',
      region: process.env.MEDIA_S3_REGION || 'auto',
      publicBase: process.env.MEDIA_PUBLIC_BASE || '',
    },

    /**
     * Identity documents, contracts and payment proofs: never public.
     *
     * The private folder used to sit inside the public one (MEDIA_DIR/private)
     * and was kept out only by a check on the first path segment, which
     * `/media/%70rivate/...` or `/media/./private/...` walked straight past. It
     * is now a separate folder outside the publicly served root, so no spelling
     * of a public URL can reach it. Defaults to a sibling of MEDIA_DIR.
     */
    privateDir: process.env.MEDIA_PRIVATE_DIR
      || `${String(process.env.MEDIA_DIR || 'storage/media').replace(/[\\/]+$/, '')}-private`,

    /**
     * Who may open a private file. IDs and bank receipts are not for every
     * dashboard login: support and finance staff saw every nanny's national ID.
     * Comma-separated admin roles.
     */
    privateRoles: (process.env.MEDIA_PRIVATE_ROLES || 'admin,super_admin')
      .split(',').map((r) => r.trim()).filter(Boolean),

    /**
     * Private files in object storage, so they survive a deploy.
     *
     * Must be a separate bucket from the public one and must never be given a
     * public domain: on R2 and most providers a public bucket exposes every
     * key in it, so a "private/" prefix in the public bucket is not private.
     * Files are served only through the logged-in /media-private route, which
     * streams them from here. Credentials and endpoint default to the public
     * bucket's when unset.
     */
    privateS3: {
      bucket: process.env.MEDIA_PRIVATE_S3_BUCKET || '',
      prefix: process.env.MEDIA_PRIVATE_S3_PREFIX ?? 'private/',
      endpoint: process.env.MEDIA_PRIVATE_S3_ENDPOINT || process.env.MEDIA_S3_ENDPOINT || '',
      accessKeyId: process.env.MEDIA_PRIVATE_S3_KEY || process.env.MEDIA_S3_KEY || '',
      secretAccessKey: process.env.MEDIA_PRIVATE_S3_SECRET || process.env.MEDIA_S3_SECRET || '',
      region: process.env.MEDIA_PRIVATE_S3_REGION || process.env.MEDIA_S3_REGION || 'auto',
    },

    /**
     * Where `store()` may download from.
     *
     * It used to fetch any http(s) URL it was handed, from inside our own
     * network — a way to make the server request internal addresses or cloud
     * metadata endpoints. Only the WhatsApp provider's media storage is
     * allowed. Entries are a host ("ultramsgmedia.s3.amazonaws.com"), a
     * wildcard host ("*.example.com"), or a host plus path prefix
     * ("s3.eu-central-1.amazonaws.com/ultramsgmedia/") — the path matters on
     * shared hosts like S3, where any stranger's bucket has the same hostname.
     */
    allowedSources: (process.env.MEDIA_ALLOWED_SOURCES
      || 's3.eu-central-1.amazonaws.com/ultramsgmedia/,ultramsgmedia.s3.eu-central-1.amazonaws.com,ultramsgmedia.s3.amazonaws.com,s3.amazonaws.com/ultramsgmedia/')
      .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
  },

  brand: {
    name: process.env.BRAND_NAME || 'Nanny in Paradise',
    // Must be a public URL — mail clients cannot read files from our disk.
    // Left unset, emails show the wordmark alone rather than a broken image.
    logoUrl: process.env.BRAND_LOGO_URL || '',
  },

  /** Where the end-of-day backup goes. */
  backup: {
    /**
     * No built-in address.
     *
     * This defaulted to one person's personal Gmail, so a server deployed
     * without BACKUP_EMAIL mailed every family's name, phone and address to an
     * inbox outside the company every night. Now nothing is sent until an
     * address is configured here or in the dashboard's backup recipients.
     */
    email: (process.env.BACKUP_EMAIL || '').trim(),
    // Local hour to send at, in the server's timezone.
    hour: int(process.env.BACKUP_HOUR, 23),
    /**
     * Encrypts every backup attachment (AES-256-GCM, key derived with scrypt).
     *
     * An emailed spreadsheet of every customer sits in mailboxes, phones and
     * mail-provider logs for years. Without this set, production refuses to
     * email the backup at all rather than send it in the clear; decrypt with
     * `node scripts/decrypt-backup.mjs <file>`.
     */
    password: process.env.BACKUP_PASSWORD || '',
    /**
     * Where the full database dump is written (gzipped JSON of every
     * collection, encrypted when BACKUP_PASSWORD is set). Must be persistent
     * storage to be worth anything; the dump is also uploaded to the private
     * bucket when one is configured.
     */
    dir: process.env.BACKUP_DIR || 'storage/backups',
    // How many nightly dumps to keep on local disk.
    keep: int(process.env.BACKUP_KEEP, 14),
  },

  // Response windows (spec: 1h new booking, 2h existing booking change)
  newBookingResponseMinutes: int(process.env.NEW_BOOKING_RESPONSE_MINUTES, 60),
  changeBookingResponseMinutes: int(process.env.CHANGE_BOOKING_RESPONSE_MINUTES, 120),

  reschedulePenaltyPercent: int(process.env.RESCHEDULE_PENALTY_PERCENT, 5),
  freeRescheduleLimit: int(process.env.FREE_RESCHEDULE_LIMIT, 3),
  // Overtime past this is almost always an end-of-service code entered late
  // (the next morning), not work. It is not charged automatically; the office
  // confirms real long overtime by hand.
  maxAutoOvertimeHours: int(process.env.MAX_AUTO_OVERTIME_HOURS, 4),
  liveLocationWindowHours: int(process.env.LIVE_LOCATION_WINDOW_HOURS, 2),
};

export default config;
