import { sendText } from '../providers/ultramsg.js';
import { User, Session } from '../models/index.js';

/**
 * Outbound messaging helpers. Every system-initiated message goes through here
 * so delivery failures never crash a flow or a scheduled job.
 */

export async function notifyPhone(phone, body, meta = {}) {
  if (!phone) return { skipped: true };
  try {
    await sendText(phone, body, meta);
    return { sent: true };
  } catch (err) {
    console.error(`[notify] failed to message ${phone}: ${err.message}`);
    return { sent: false, error: err.message };
  }
}

export async function notifyUser(userOrId, body, meta = {}) {
  const user = typeof userOrId === 'object' && userOrId?.phone
    ? userOrId
    : await User.findById(userOrId);
  if (!user?.phone) return { skipped: true };
  return notifyPhone(user.phone, body, { role: user.role, ...meta });
}

/**
 * Send a message AND move the recipient's conversation to a given state, so an
 * unprompted system message (e.g. a booking request) can be replied to directly.
 */
export async function notifyAndSetState(userOrId, body, state, data = {}) {
  const user = typeof userOrId === 'object' && userOrId?.phone
    ? userOrId
    : await User.findById(userOrId);
  if (!user?.phone) return { skipped: true };

  const session = await Session.findOne({ phone: user.phone });
  if (session) {
    session.state = state;
    session.data = { ...(session.data || {}), ...data };
    session.markModified('data');
    await session.save();
  }
  return notifyPhone(user.phone, body, { role: user.role, state });
}

export default { notifyPhone, notifyUser, notifyAndSetState };
