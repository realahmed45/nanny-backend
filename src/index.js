import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import config from './config/index.js';
import { connectDB } from './config/db.js';
import { AdminUser } from './models/index.js';
import webhookRoutes from './routes/webhook.js';
import adminRoutes from './routes/admin.js';
import { startScheduler } from './jobs/scheduler.js';
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
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      service: 'my-nanny-server',
      env: config.env,
      whatsapp: isDryRun() ? 'dry-run (no WhatsApp credentials)' : 'live',
      email: emailIsDryRun() ? 'dry-run (no email provider configured)' : `live (${emailProviderName()})`,
      payments: 'manual bank transfer (admin-verified)',
      time: new Date().toISOString(),
    });
  });

  app.use('/webhook', webhookRoutes);
  app.use('/api/admin', adminRoutes);

  // Referral landing link.
  app.get('/r/:code', (req, res) => {
    res.send(`<!doctype html><meta charset="utf-8"><title>My Nanny</title>
<body style="font-family:system-ui;max-width:560px;margin:80px auto;padding:0 24px;text-align:center">
<h1>👶 My Nanny</h1>
<p>You were referred with code <strong>${escapeHtml(req.params.code)}</strong>.</p>
<p>Message us on WhatsApp to get started, and mention this code.</p>
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

async function main() {
  await connectDB();
  await ensureAdmin().catch((err) => {
    console.error('[admin] bootstrap failed:', err.message);
  });

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[server] listening on http://localhost:${config.port}`);
    console.log(`[server] webhook URL: ${config.publicBaseUrl}/webhook/ultramsg`);
    if (isDryRun()) {
      console.log('[server] ⚠️  UltraMsg credentials missing — messages will be logged, not sent.');
    }
  });

  startScheduler();
}

// Only auto-start when run directly (tests import createApp instead).
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  main().catch((err) => {
    console.error('[server] failed to start:', err);
    process.exit(1);
  });
}

export default createApp;
