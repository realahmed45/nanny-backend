/**
 * A brake on repeated attempts.
 *
 * Kept in memory rather than in the database or a separate service: the thing
 * being defended against is a flood, and a defence that writes to disk on
 * every attempt becomes the outage it was meant to prevent. The cost is that
 * counters reset when the server restarts, which is an acceptable trade — an
 * attacker cannot force a restart, and a real one loses their progress too.
 */

/** One bucket of attempts, keyed by whatever the caller counts by. */
const buckets = new Map();

/** Drop everything that has aged out, so the map cannot grow without limit. */
function sweep(now) {
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now && (!entry.lockedUntil || entry.lockedUntil <= now)) {
      buckets.delete(key);
    }
  }
}

let lastSweep = 0;

/**
 * Count an attempt and say whether it is allowed.
 *
 * Returns `{ allowed, retryAfter }` — seconds until they may try again.
 */
export function hit(key, { max, windowMs, lockMs }) {
  const now = Date.now();

  // Sweeping on a timer rather than on every call: at a flood's rate, walking
  // the whole map per attempt is exactly the work an attacker wants us doing.
  if (now - lastSweep > 60_000) {
    sweep(now);
    lastSweep = now;
  }

  let entry = buckets.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs, lockedUntil: 0 };
    buckets.set(key, entry);
  }

  if (entry.lockedUntil > now) {
    return { allowed: false, retryAfter: Math.ceil((entry.lockedUntil - now) / 1000) };
  }

  entry.count += 1;
  if (entry.count > max) {
    entry.lockedUntil = now + lockMs;
    return { allowed: false, retryAfter: Math.ceil(lockMs / 1000) };
  }

  return { allowed: true, retryAfter: 0 };
}

/** Wipe the count for a key — called when an attempt actually succeeds. */
export function clear(key) {
  buckets.delete(key);
}

/**
 * Express middleware form.
 *
 * `by` decides what is counted. Login counts by IP *and* by the email being
 * tried, because either alone is easy to work around: one attacker with many
 * addresses, or many attackers against one account.
 */
export function rateLimit({ max = 10, windowMs = 15 * 60_000, lockMs = 15 * 60_000, by }) {
  return (req, res, next) => {
    const keys = (by ? by(req) : [req.ip]).filter(Boolean);

    for (const key of keys) {
      const { allowed, retryAfter } = hit(key, { max, windowMs, lockMs });
      if (!allowed) {
        res.set('Retry-After', String(retryAfter));
        const mins = Math.ceil(retryAfter / 60);
        return res.status(429).json({
          error: `Too many attempts. Please wait ${mins} minute${mins === 1 ? '' : 's'} and try again.`,
        });
      }
    }

    // Hand back the keys so a successful request can clear its own count:
    // someone who signs in correctly should not be nearer a lockout for it.
    res.locals.rateLimitKeys = keys;
    return next();
  };
}

export default { rateLimit, hit, clear };
