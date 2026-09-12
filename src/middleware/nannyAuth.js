import jwt from 'jsonwebtoken';
import config from '../config/index.js';

/**
 * Sign-in for the nanny app.
 *
 * Separate from the admin token deliberately. An admin token opens every
 * record in the business; a nanny token must open exactly one nanny's own
 * data and nothing else. Sharing a signing path between them means one
 * mistake in a role check exposes everything, so they do not share one — a
 * nanny token carries `kind: 'nanny'` and the admin middleware rejects it.
 *
 * Tokens last a long time because the alternative is worse: a nanny who is
 * signed out mid-week misses the emergency notification that the app exists
 * to deliver. Her number is the account, so losing the phone is the real
 * revocation, and blocking her account invalidates it server-side anyway.
 */

const TOKEN_TTL = '90d';

export function signNannyToken(nanny) {
  return jwt.sign(
    { sub: String(nanny._id), kind: 'nanny', phone: nanny.phone },
    config.jwtSecret,
    { expiresIn: TOKEN_TTL },
  );
}

/**
 * Require a valid nanny token, and load her.
 *
 * Re-reads the account on every request rather than trusting the token's
 * contents: a nanny suspended this morning must stop working this morning,
 * not in ninety days when her token expires.
 */
export async function requireNanny(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in' });

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }

  // An admin token must not open the nanny app, and vice versa.
  if (payload.kind !== 'nanny') {
    return res.status(401).json({ error: 'Not signed in' });
  }

  const { User } = await import('../models/index.js');
  const { USER_ROLE, NANNY_STATUS } = await import('../utils/constants.js');

  const nanny = await User.findOne({ _id: payload.sub, role: USER_ROLE.NANNY });
  if (!nanny) return res.status(401).json({ error: 'Account not found' });

  if (nanny.blocked || nanny.nannyStatus === NANNY_STATUS.SUSPENDED) {
    return res.status(403).json({
      error: 'Your account is on hold. Please contact support.',
    });
  }

  req.nanny = nanny;
  return next();
}

export default { signNannyToken, requireNanny };
