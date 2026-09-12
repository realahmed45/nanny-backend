import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import config from './config/index.js';
import mongoose from 'mongoose';
import { connectDB } from './config/db.js';
import { AdminUser } from './models/index.js';
import webhookRoutes from './routes/webhook.js';
import adminRoutes from './routes/admin.js';
import nannyAppRoutes from './routes/nannyApp.js';
import { startScheduler } from './jobs/scheduler.js';
import { mountMediaRoutes } from './services/mediaArchive.js';
import { isDryRun } from './providers/ultramsg.js';
import { isDryRun as emailIsDryRun, activeProvider as emailProviderName } from './providers/email.js';
import './flows/index.js';   // registers every conversation state

export function createApp() {
  const app = express();

  // Lock CORS to the dashboard's origin in production. CORS_ORIGINS is a
  // comma-separated list; unset means allow any origin (fine for local dev).
  //
  // Origins are compared with the trailing slash stripped: browsers always
  // send "https://host" with no path, but it is very easy to paste
  // "https://host/" into the dashboard, and an exact match would then
  // silently reject every request as a CORS error.
  const normalize = (o) => String(o || '').trim().replace(/\/+$/, '').toLowerCase();
  const allowed = new Set(
    (process.env.CORS_ORIGINS || '').split(',').map(normalize).filter(Boolean),
  );

  app.use(cors(allowed.size
    ? {
        origin(origin, cb) {
          // No Origin header: same-origin, curl, or a server-side call.
          if (!origin) return cb(null, true);
          return cb(null, allowed.has(normalize(origin)));
        },
        credentials: true,
      }
    : {}));
  /**
   * Uploads from the phone app arrive as base64 in the body, so that one route
   * needs far more room than the rest of the API. The limit stays low
   * everywhere else: a 64MB ceiling on every endpoint is a way to exhaust the
   * server's memory with a request that does nothing.
   */
  app.use('/api/nanny/media', express.json({ limit: '72mb' }));
  app.use(express.json({ limit: '2mb' }));

  // Serve our own copies of nanny media. Read-only and long-cached: a stored
  // file never changes, since its name is a hash of where it came from.
  mountMediaRoutes(app, express);
  app.use(express.urlencoded({ extended: true }));

  /**
   * Is this thing working?
   *
   * `ok` follows the database rather than being hard-coded true. The server
   * now starts before the database is reachable — which is what stops a slow
   * database from failing the whole deploy — so a health check that always
   * said "ok" would hide exactly the state this exists to report.
   */
  app.get('/health', (req, res) => {
    // 0 disconnected, 1 connected, 2 connecting, 3 disconnecting.
    const DB_STATE = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    const dbState = DB_STATE[mongoose.connection.readyState] || 'unknown';
    const dbReady = mongoose.connection.readyState === 1;

    res.status(dbReady ? 200 : 503).json({
      ok: dbReady,
      service: 'my-nanny-server',
      env: config.env,
      database: dbState,
      whatsapp: isDryRun() ? 'dry-run (no WhatsApp credentials)' : 'live',
      email: emailIsDryRun() ? 'dry-run (no email provider configured)' : `live (${emailProviderName()})`,
      payments: 'manual bank transfer (admin-verified)',
      time: new Date().toISOString(),
    });
  });

  app.use('/webhook', webhookRoutes);
  app.use('/api/admin', adminRoutes);
  // The phone app's door. Separate from the admin API because the tokens are
  // separate: a nanny token opens her own records and nothing else.
  app.use('/api/nanny', nannyAppRoutes);

  /**
   * Referral landing link.
   *
   * Opens WhatsApp with the trigger word and the code already typed, so the
   * visitor only has to press send. Asking them to remember a code and find
   * the number themselves loses most of them, and an unattributed signup
   * cannot be credited to whoever referred them.
   */
  /**
   * Wire 1 — the tracked redirect.
   *
   * Logs the click server-side *before* handing off to WhatsApp. This is the
   * only way to see someone who tapped and walked away: the row carries no
   * phone number, because the number is not knowable yet.
   *
   * Public by design, so it is rate-limited — it writes a row per request.
   */
  const redirectHits = new Map();
  const REDIRECT_LIMIT = 30;          // per IP
  const REDIRECT_WINDOW_MS = 60_000;

  app.get('/r/:code', async (req, res) => {
    // Express decodes %2F inside a route parameter, so :code can arrive
    // carrying "../..". Canonicalising to the code alphabet before any
    // lookup is what stops that mattering.
    const { canonCode, recordClick, findLink } = await import('./services/shareLink.js');
    const code = canonCode(req.params.code);

    if (!code) return res.status(400).send('Invalid link.');

    // Cheap fixed-window limit. A shared office IP hitting it just means the
    // click is not counted; the redirect still happens.
    const now = Date.now();
    const seen = redirectHits.get(req.ip);
    let limited = false;
    if (!seen || now - seen.since > REDIRECT_WINDOW_MS) {
      redirectHits.set(req.ip, { since: now, n: 1 });
    } else {
      seen.n += 1;
      limited = seen.n > REDIRECT_LIMIT;
    }
    // Keep the map from growing without bound on a busy day.
    if (redirectHits.size > 5000) {
      for (const [ip, v] of redirectHits) {
        if (now - v.since > REDIRECT_WINDOW_MS) redirectHits.delete(ip);
      }
    }

    let link = null;
    let sharerCode = code;

    try {
      if (!limited) {
        // A minted ShareLink, or a person's permanent referral code — both
        // reach the same chat, but only the first has a window on it.
        link = await findLink(code);

        if (link) {
          await recordClick(code, '', {
            source: 'web_redirect',
            userAgent: req.get('user-agent'),
            ip: req.ip,
          });
          sharerCode = link.sharerCode || code;
        } else {
          // The older permanent-code road, kept working.
          const { User, ReferralClick } = await import('./models/index.js');
          const referrer = await User.findOne({ referralCode: code }).select('_id referralCode');
          await ReferralClick.create({
            code,
            referrer: referrer?._id,
            userAgent: req.get('user-agent'),
            ip: req.ip,
          });
        }
      }
    } catch (err) {
      // Tracking must never stop someone reaching the chat.
      console.error('[referral] could not record click:', err.message);
    }

    // A favourite-nanny link names who was recommended, so the chat can open
    // on that nanny instead of a generic search.
    let suffix = '';
    const nannyId = String(req.query.n || '').trim();
    if (/^[a-f\d]{24}$/i.test(nannyId)) {
      try {
        const { User } = await import('./models/index.js');
        const nanny = await User.findById(nannyId).select('_id role');
        if (nanny && nanny.role === 'nanny') suffix = ` N${nannyId}`;
      } catch {
        // A bad or missing nanny just means an ordinary referral.
      }
    }
    if (!suffix && link?.kind === 'nanny' && link.nanny) suffix = ` N${link.nanny}`;

    const number = config.referral.whatsappNumber;
    // The code in the message is the one that was clicked, so attribution
    // resolves against the same link the click was logged against.
    const message = encodeURIComponent(`nanny ${code}${suffix}`);

    if (number) {
      return res.redirect(`https://wa.me/${number}?text=${message}`);
    }

    // No number configured: say what to do rather than redirecting nowhere.
    return res.send(`<!doctype html><meta charset="utf-8"><title>My Nanny</title>
<body style="font-family:system-ui;max-width:560px;margin:80px auto;padding:0 24px;text-align:center">
<h1>\u{1F476} My Nanny</h1>
<p>You were referred with code <strong>${escapeHtml(sharerCode)}</strong>.</p>
<p>Message us on WhatsApp with <strong>nanny ${escapeHtml(code)}</strong> to get started.</p>
</body>`);
  });

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[api] unhandled error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Make sure the dashboard can be signed into.
 *
 * Creating only when ADMIN_EMAIL is missing left a hole: if the account was
 * never created, or was removed, or ADMIN_EMAIL changed after the first boot,
 * the database could end up with no admin at all and no way in. So the check
 * is on the collection being empty, not on one specific address.
 */
async function ensureAdmin() {
  const email = (config.admin.email || '').toLowerCase().trim();
  const existing = email ? await AdminUser.findOne({ email }) : null;
  if (existing) return existing;

  if (!email || !config.admin.password) {
    const total = await AdminUser.countDocuments();
    if (total === 0) {
      console.error(
        '[admin] no admin account exists and ADMIN_EMAIL/ADMIN_PASSWORD are not set. '
        + 'Nobody can sign in to the dashboard. Set them and restart, or run: node create-admin.mjs <email> <password>',
      );
    }
    return null;
  }

  try {
    const admin = await AdminUser.create({
      email,
      passwordHash: await bcrypt.hash(config.admin.password, 10),
      name: 'Administrator',
      role: 'super_admin',
    });
    console.log(`[admin] bootstrap account created: ${admin.email}`);
    return admin;
  } catch (err) {
    // Never take the server down over this, but make it impossible to miss:
    // a silent failure here is what leaves a deployment with no way in.
    console.error(`[admin] could not create the bootstrap account: ${err.message}`);
    const total = await AdminUser.countDocuments().catch(() => 0);
    if (total === 0) {
      console.error('[admin] WARNING: this database has no admin accounts. Run: node create-admin.mjs <email> <password>');
    }
    return null;
  }
}

/**
 * Start listening first, then connect to the database.
 *
 * The order matters more than it looks. Connecting first meant a database
 * that was slow or unreachable took the whole deploy down: connectDB throws
 * after ten seconds, main() rejected, app.listen was never reached, and the
 * host saw a process that had bound no port at all. The logs said "no open
 * ports detected", which points at the web server and not at the real
 * culprit — so the failure was both fatal and misleading.
 *
 * Binding the port first means the service comes up, answers /health with an
 * honest "database: connecting", and recovers by itself the moment the
 * database is reachable. A site that is briefly degraded is worth a great deal
 * more than one that will not boot.
 */
async function main() {
  const app = createApp();

  // 0.0.0.0, not localhost: a container's health check comes from outside the
  // container, and the default binding refuses it.
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[server] listening on 0.0.0.0:${config.port}`);
    console.log(`[server] webhook URL: ${config.publicBaseUrl}/webhook/ultramsg`);
    if (isDryRun()) {
      console.log('[server] \u26A0\uFE0F  UltraMsg credentials missing \u2014 messages will be logged, not sent.');
    }
  });

  server.on('error', (err) => {
    // Nothing can be served without a port, so this one is worth dying over.
    console.error(`[server] could not bind port ${config.port}: ${err.message}`);
    process.exit(1);
  });

  try {
    await connectDB();
  } catch (err) {
    // Loud, and repeated: mongoose keeps retrying underneath, so the process
    // stays up and starts working the moment the database answers. The most
    // common cause by far is the database refusing this host's IP address.
    console.error(`[db] could not connect: ${err.message}`);
    console.error('[db] the server is up but cannot read or write yet. '
      + 'Check MONGODB_URI, and that this host\'s IP is allowed by the database.');
  }

  await ensureAdmin().catch((err) => {
    console.error('[admin] bootstrap failed:', err.message);
  });

  startScheduler();
}

// Only auto-start when run directly (tests import createApp instead).
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
/**
 * Keep the bot alive through an unexpected error.
 *
 * Node's default is to print the error and exit. For a web server that is
 * usually right — but this process is also holding every WhatsApp conversation
 * in progress, and one odd booking in a background job at 2am should not end
 * all of them. Nobody would notice until morning, and everyone who messaged
 * overnight would have been met with silence.
 *
 * So the error is logged loudly and the process carries on. This is a net,
 * not a cure: a fault that keeps recurring will fill the logs, which is the
 * point — it stays visible instead of being hidden by a restart.
 */
function installCrashGuards() {
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandled promise rejection — staying up:', reason);
  });

  process.on('uncaughtException', (err) => {
    console.error('[server] uncaught exception — staying up:', err);
  });

  // A deliberate stop should still be clean: finish what is in flight rather
  // than dropping a reply half-sent.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(`[server] ${signal} received, shutting down`);
      process.exit(0);
    });
  }
}

if (isMain) {
  installCrashGuards();
  main().catch((err) => {
    console.error('[server] failed to start:', err);
    process.exit(1);
  });
}

export default createApp;
