# Getting verification codes delivered (Brevo)

## What was wrong

The server was sending from `onboarding@resend.dev` — Resend's shared test
address. That address only delivers to the one email you signed up to Resend
with; every other recipient is silently dropped. So the code was created and
stored correctly, and nobody ever received it.

## The fix

Send through Brevo instead, using the Gmail sender you have already verified
(`chatbiz <realahmedali4@gmail.com>`).

---

## Step 1 — get the SMTP credentials

In Brevo: the **gear icon** (top right) → **SMTP & API** → **SMTP** tab.

Two values to copy:

| | Looks like |
|---|---|
| **Login** | `8a1b2c001@smtp-brevo.com` |
| **Master password** | `xsmtpsib-...` (long) |

These are not your Brevo account password.

---

## Step 2 — set these on Render

Render → your backend service → **Environment**:

```
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=<the login from step 1>
SMTP_PASS=<the master password from step 1>
SMTP_FROM=Nanny in Paradise <realahmedali4@gmail.com>
```

The address inside `SMTP_FROM` **must** be the one verified in Brevo, or Brevo
rejects the message. The name in front of it can be anything.

---

## Step 3 — delete RESEND_API_KEY

**This step is not optional.** The server picks its mail provider by checking
Resend first, so while that key is set your Brevo settings are ignored and
nothing changes.

Render → Environment → find `RESEND_API_KEY` → delete it → save.

Render redeploys on its own, taking a minute or two.

---

## Step 4 — check it took

Open:

    https://nanny-backend-hw1q.onrender.com/health

Look at the `email` field:

| It says | Meaning |
|---|---|
| `live (smtp)` | ✅ Brevo is in use |
| `live (resend)` | ❌ `RESEND_API_KEY` is still set — step 3 |
| `dry-run (console)` | ❌ `SMTP_HOST` is missing or misspelled |

Then register on WhatsApp with a real email and confirm the code arrives.

---

## Expect some mail in spam

Sending as a `gmail.com` address means Google's DNS does not list Brevo as
allowed to send on its behalf. Mail goes out and most arrives, but some lands
in spam. Worth telling early nannies to check their spam folder.

Brevo's own warnings on the sender page — "DKIM: Default" and "Freemail domain
is not recommended" — are saying exactly this. They do not stop it working.

---

## The proper fix, when you want it

You already own **futurelifebali.com** (it is on Vercel DNS). Sending from
`no-reply@futurelifebali.com` removes the spam problem entirely, because the
domain can say Brevo is allowed to send for it.

1. Brevo → **Domains** → Add domain → `futurelifebali.com`
2. Brevo shows 2–3 DNS records
3. Vercel → your project → **Domains** → **DNS** → add each record
4. On Render change one line:
   `SMTP_FROM=Nanny in Paradise <no-reply@futurelifebali.com>`

Roughly fifteen minutes, plus DNS propagation. Nothing else changes.

---

## Free limits

Brevo's free tier is **300 emails a day**. For verification codes that is
around 300 signups daily — far more than you need for a long time.
