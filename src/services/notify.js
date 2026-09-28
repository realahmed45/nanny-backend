import { sendText } from '../providers/ultramsg.js';
import { User, Session } from '../models/index.js';

/**
 * Outbound messaging helpers. Every system-initiated message goes through here
 * so delivery failures never crash a flow or a scheduled job.
 */

/**
 * Try again before giving up on a message.
 *
 * A failed send was invisible: it was recorded in the message log with its
 * error, and nothing read that back — no retry, no alert. The messages this
 * carries are the ones that cannot be missed. If the arrival code fails to
 * reach a family, the nanny is standing at the door and the code will never be
 * sent again, because the sweep that sent it has already moved that day on.
 *
 * Most provider failures are a moment long — a rate limit, a dropped
 * connection. Three tries a few seconds apart clears those. A number that is
 * genuinely unreachable fails all three quickly, so nothing waits long.
 */
const SEND_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

export async function notifyPhone(phone, body, meta = {}) {
  if (!phone) return { skipped: true };

  let lastError;
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await sendText(phone, body, meta);
      if (attempt > 1) console.warn(`[notify] message to ${phone} succeeded on attempt ${attempt}`);
      return { sent: true, attempts: attempt };
    } catch (err) {
      lastError = err;
      if (attempt < SEND_ATTEMPTS) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
      }
    }
  }

  // Loud, and named as undelivered rather than merely "failed", because the
  // recipient does not know a message was meant for them.
  console.error(
    `[notify] UNDELIVERED to ${phone} after ${SEND_ATTEMPTS} attempts: ${lastError?.message}`,
  );
  return { sent: false, error: lastError?.message, attempts: SEND_ATTEMPTS };
}

export async function notifyUser(userOrId, body, meta = {}) {
  const user = typeof userOrId === 'object' && userOrId?.phone
    ? userOrId
    : await User.findById(userOrId);
  if (!user?.phone) return { skipped: true };
  // Their language, so a reminder or a booking alert arrives in it. Every
  // system-initiated message passes through here, which is why this one line
  // covers reminders, broadcasts and scheduler jobs alike.
  return notifyPhone(user.phone, body, { role: user.role, locale: user.locale, ...meta });
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

/**
 * States it is safe to pull somebody out of to hand them a chat message.
 *
 * A menu is a safe place to interrupt: nothing is half-entered, so dropping her
 * into the chat loses nothing. A booking flow is not — she may be part-way
 * through a decline reason or an arrival code, and her next message belongs to
 * that question. Interrupting there would feed her reply into a field, and on a
 * booking request a "1" would accept the job.
 */
const INTERRUPTIBLE = new Set([
  'START',
  'FAMILY_MAIN_MENU',
  'NANNY_MAIN_MENU',
  'FF_CHAT_CLOSED',
  'NANNY_CHAT_CLOSED',
]);

/**
 * Deliver a relayed chat message, and put the recipient into the chat when it is
 * safe to — so that what she types next reaches the person who wrote to her.
 *
 * Relaying used to notify and stop there, touching nothing. The recipient stayed
 * on whatever screen she was on, so her reply was parsed as a menu choice and
 * the sender got nothing back. She had no way to tell, and from the sender's
 * side she was simply ignoring them.
 *
 * Returns whether she can reply right now, so the caller can say so rather than
 * implying a conversation that is not open.
 */
export async function relayChatMessage(userOrId, body, { threadId } = {}) {
  const user = typeof userOrId === 'object' && userOrId?.phone
    ? userOrId
    : await User.findById(userOrId);
  if (!user?.phone) return { skipped: true, live: false };

  const session = await Session.findOne({ phone: user.phone });
  const chatState = user.role === 'nanny' ? 'NANNY_CHATTING' : 'FF_CHATTING';

  let live = false;
  if (session) {
    // Already in this chat, or somewhere safe to be moved into it.
    const inThisChat = String(session.activeChat || '') === String(threadId || '');
    if (inThisChat || INTERRUPTIBLE.has(session.state)) {
      session.state = chatState;
      session.activeChat = threadId;
      await session.save();
      live = true;
    }
  }

  const sent = await notifyPhone(user.phone, body, { role: user.role, state: session?.state });
  return { ...sent, live };
}

export default {
  notifyPhone, notifyUser, notifyAndSetState, relayChatMessage,
};
