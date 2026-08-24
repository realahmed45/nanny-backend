# My Nanny — Backend

WhatsApp chatbot (UltraMsg) + admin API for the My Nanny childcare marketplace.
Families and nannies interact entirely through WhatsApp; staff use the separate
admin dashboard, which talks to the `/api/admin` endpoints here.

Built from `Draft 2 of My Nanny Chatbot Script.md` — the conversation copy,
booking rules, refund policy and dashboard requirements all come from that spec.

---

## Quick start

```bash
npm install
cp .env.example .env      # then fill in the values below
npm start
```

The server boots on `http://localhost:4000`, creates the bootstrap admin
account, and starts the background schedulers.

```bash
npm test                  # 30 tests: policy, parsing, full conversation flows
npm run dev               # auto-restart on change
```

---

## Environment

| Variable | Required | Notes |
|---|---|---|
| `MONGODB_URI` | ✅ | MongoDB connection string (Atlas works out of the box) |
| `PORT` | | Defaults to `4000` |
| `PUBLIC_BASE_URL` | ✅ in prod | Public URL of this server; used for referral links |
| `JWT_SECRET` | ✅ in prod | Signing secret for admin sessions — use a long random value |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | ✅ | Bootstrap admin, created on first boot. **Change the password after first login.** |
| `ULTRAMSG_INSTANCE_ID` | ✅ to send | From your UltraMsg instance |
| `ULTRAMSG_TOKEN` | ✅ to send | From your UltraMsg instance |
| `ULTRAMSG_WEBHOOK_TOKEN` | recommended | If set, webhook calls must include `?token=<value>` |
| `CORS_ORIGINS` | ✅ in prod | Comma-separated dashboard origins; empty allows any origin |

Business rules (all optional, sensible defaults applied):
`CURRENCY`, `TRANSPORT_FEE_MIN`, `TRANSPORT_FEE_MAX`,
`NEW_BOOKING_RESPONSE_MINUTES` (60), `CHANGE_BOOKING_RESPONSE_MINUTES` (120),
`RESCHEDULE_PENALTY_PERCENT` (5), `FREE_RESCHEDULE_LIMIT` (3),
`LIVE_LOCATION_WINDOW_HOURS` (2).

> **Dry-run mode:** without UltraMsg credentials the bot logs outbound messages
> instead of sending them. Everything else works, so you can exercise the flows
> before connecting WhatsApp.

---

## Connecting WhatsApp

1. Create an instance at [user.ultramsg.com](https://user.ultramsg.com) and scan
   the QR code with the phone number customers will message.
2. Copy the **Instance ID** and **Token** into `.env`.
3. In the UltraMsg dashboard set the webhook URL to:
   ```
   https://<your-domain>/webhook/ultramsg
   ```
   and enable the **Message Received** event.
4. Locally, expose the port with a tunnel and use that URL instead:
   ```bash
   npx cloudflared tunnel --url http://localhost:4000
   ```
5. Send "Hi" to the number — you should get the welcome menu.

---

## Architecture

```
src/
  config/      env + mongo connection
  models/      User, Booking, Session, Payment/Payout, ChatThread, Ticket, …
  services/    policy (refunds), booking, matching, payments, notify
  flows/       the conversation state machine (173 states)
  jobs/        cron: response timeouts, service days, reminders, payouts
  routes/      /webhook/ultramsg, /api/admin/*
  providers/   ultramsg, payments, email, storage  ← swap these for real vendors
```

**The conversation engine** (`flows/engine.js`) routes each inbound message to a
handler registered for the session's current state. A handler returns a string
or `{ text, state }` and the engine sends the reply and transitions the session.
Global commands (`0`, `Back`, `Next`, `Bye`, `Cancel`, `None`) are handled
centrally; chat-relay states opt out so those words reach the other person.

**Policy** (`services/policy.js`) is the single source of truth for money:
cancellation bands, reschedule penalties, overtime rounding and booking totals.
It is pure and fully unit-tested against the spec tables.

---

## Background jobs

| Job | Schedule | What it does |
|---|---|---|
| Response timeouts | every minute | Expires the nanny's 1h / 2h window, unassigns her, offers the family replacements |
| Service day transitions | every minute | Starts a day (issues the arrival code), ends it (issues the end-of-service code) |
| Replacement deadlines | every 15 min | Reminds the family, auto-cancels + refunds if no replacement by the next service |
| Reminders | every 15 min | Tells the family live location opens 2h before service |
| Payouts | Mondays 09:00 | Releases nanny payouts (spec: paid every Monday) |

---

## Going live: swapping the mock providers

Payments, email and file storage ship as mocks behind small interfaces so the
flows are fully exercisable. Each is a drop-in replacement:

- **`providers/payments.js`** — implement `charge`, `refund`, `payout` against
  Stripe/PayPal and export it as `gateway`. Nothing in the flows changes.
- **`providers/email.js`** — implement `send` with nodemailer/SES for the
  verification codes.
- **`providers/storage.js`** — currently records UltraMsg's hosted media URL;
  swap for S3/GCS if you need to re-host ID documents.

---

## Admin API

`POST /api/admin/auth/login` returns a bearer token; every other route requires
`Authorization: Bearer <token>`.

Dashboard `/dashboard/stats` · Nannies `/nannies` (+ `verify`, `reject`,
`suspend`, delete) · Families `/families` · Bookings `/bookings` (+
`refund-preview`, `cancel`, `assign-nanny`) · Payments `/payments`,
`/payments/summary`, `/payouts` (+ `release`) · Support `/tickets` (+ `reply`)
· Chats `/chats`, `/messages` (+ `send`) · `/settings`.

---

## Deployment (Render / Railway / Fly)

- Build: `npm install` · Start: `npm start` (a `Procfile` is included)
- Set every environment variable from the table above
- Point the UltraMsg webhook at `https://<your-domain>/webhook/ultramsg`
- Set `PUBLIC_BASE_URL` to the deployed URL

The scheduler runs in-process, so run **one** instance — or move the jobs to a
dedicated worker before scaling horizontally, so timeouts don't fire twice.
