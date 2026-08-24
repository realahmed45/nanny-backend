# My Nanny — Deployment Guide

Two services: the **backend** (`nanny-backend`) and the **admin dashboard**
(`nanny-frontend`). Deploy the backend first — the dashboard needs its URL.

---

## Readiness at a glance

| Piece | State | Blocks launch? |
|---|---|---|
| Chatbot conversation engine | ✅ Complete, 30 tests passing | — |
| Booking / refund / payout logic | ✅ Complete, spec-tested | — |
| Admin dashboard | ✅ Complete | — |
| Database | ✅ MongoDB Atlas connected | — |
| **WhatsApp provider** | ❌ Not connected | **Yes** — no one can message the bot |
| **Payment gateway** | ❌ Mocked (approves everything) | **Yes** — no real money moves |
| **Email (OTP delivery)** | ⚠️ Logged to console | **Yes** — users can't verify accounts |
| CORS | ⚠️ Open unless `CORS_ORIGINS` is set | Set it before launch |
| Atlas password | ⚠️ Shared in chat | Rotate before launch |

**You can deploy today** and use the admin dashboard against real data. The
chatbot will not serve real customers until the three ❌/⚠️ blockers are done.

---

## Backend environment variables

### Required

| Variable | Example | Notes |
|---|---|---|
| `MONGODB_URI` | `mongodb+srv://user:pass@cluster0.../mynanny` | Atlas connection string. **Rotate the password first.** |
| `JWT_SECRET` | 64 random hex chars | Signs admin sessions. Generate: `openssl rand -hex 32`. Never reuse the dev value. |
| `PUBLIC_BASE_URL` | `https://api.yourdomain.com` | Your deployed backend URL. Used for referral links. |
| `ADMIN_EMAIL` | `you@yourdomain.com` | Bootstrap admin, created on first boot. |
| `ADMIN_PASSWORD` | a strong password | **Change from `admin123`.** Only used on first boot. |
| `NODE_ENV` | `production` | |
| `PORT` | `4000` | Most hosts inject this automatically — let them. |
| `CORS_ORIGINS` | `https://dash.yourdomain.com` | Comma-separated. **Set this** — empty allows any origin. |

### WhatsApp (required for the bot to work at all)

| Variable | Notes |
|---|---|
| `ULTRAMSG_INSTANCE_ID` | From your provider |
| `ULTRAMSG_TOKEN` | From your provider |
| `ULTRAMSG_BASE_URL` | Defaults to `https://api.ultramsg.com`; change if you switch provider |
| `ULTRAMSG_WEBHOOK_TOKEN` | **Set this.** A random string; webhook calls must then include `?token=<value>`. Without it, anyone who finds your webhook URL can inject fake messages. |

Leave the ID and token **empty** to stay in dry-run mode (messages logged, not
sent) — useful for staging.

### Business rules (optional — sensible defaults)

| Variable | Default | Notes |
|---|---|---|
| `CURRENCY` | `USD` | ⚠️ The spec quotes transport as 50,000–100,000, which is not a USD range. Set the currency that actually matches your market. |
| `TRANSPORT_FEE_MIN` / `MAX` | `50000` / `100000` | Per the spec |
| `NEW_BOOKING_RESPONSE_MINUTES` | `60` | Spec: 1 hour |
| `CHANGE_BOOKING_RESPONSE_MINUTES` | `120` | Spec: 2 hours |
| `RESCHEDULE_PENALTY_PERCENT` | `5` | |
| `FREE_RESCHEDULE_LIMIT` | `3` | |
| `LIVE_LOCATION_WINDOW_HOURS` | `2` | |

---

## Frontend environment variables

Only one:

| Variable | Example |
|---|---|
| `VITE_API_BASE` | `https://api.yourdomain.com/api/admin` |

Vite inlines this **at build time**, not runtime — changing it means rebuilding.

---

## Deploying the backend (Render / Railway / Fly)

1. Connect the `nanny-backend` repo.
2. Build `npm install` · Start `npm start` (a `Procfile` is included).
3. Add every required variable above.
4. Deploy, then confirm:
   ```
   curl https://api.yourdomain.com/health
   ```
   Expect `{"ok":true,...}`. The `whatsapp` field reads `live` or `dry-run`.
5. Watch the first boot log for `[admin] bootstrap account created`, then sign
   in and **change the admin password**.

> **Run exactly one instance.** The scheduler runs in-process, so two instances
> would double-fire response timeouts and payouts. To scale horizontally, move
> `src/jobs/scheduler.js` to a dedicated worker first.

## Deploying the frontend (Vercel / Netlify)

1. Connect the `nanny-frontend` repo.
2. Build `npm run build` · Output `dist`.
3. Set `VITE_API_BASE` to your backend's `/api/admin` URL.
4. Deploy. SPA routing is already configured (`vercel.json`, `public/_redirects`).

---

## Before real customers

### 1. Connect WhatsApp
Get credentials, set the two variables, then point the provider's webhook at:
```
https://api.yourdomain.com/webhook/ultramsg?token=<ULTRAMSG_WEBHOOK_TOKEN>
```
Enable the **message received** event. Send "Hi" to the number — you should get
the welcome menu.

### 2. Replace the payment mock
`src/providers/payments.js` currently approves every charge and refund without
moving money. Implement `charge`, `refund` and `payout` against Stripe/PayPal
and export it as `gateway`. No flow code changes.

### 3. Replace the email mock
`src/providers/email.js` logs OTP codes instead of emailing them, so account
verification cannot complete. Implement `send` with nodemailer or SES.

### 4. Lock down CORS
Set `CORS_ORIGINS` to your dashboard's URL (comma-separated for several).
Leaving it empty allows any origin.

### 5. Rotate the Atlas password
The current password was shared in chat. Rotate it in Atlas, update
`MONGODB_URI`, and restrict Atlas network access to your backend's IP.

---

## Post-deploy smoke test

```bash
# Backend healthy
curl https://api.yourdomain.com/health

# Admin login returns a token
curl -X POST https://api.yourdomain.com/api/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@yourdomain.com","password":"<your password>"}'
```

Then open the dashboard, sign in, and confirm the Dashboard, Bookings and
Settings pages load. Settings shows whether WhatsApp is connected.
