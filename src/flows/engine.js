import { Session, User, MessageLog } from '../models/index.js';
import { sendText, normalizePhone } from '../providers/ultramsg.js';
import { detectCommand } from '../utils/parse.js';
import { USER_ROLE } from '../utils/constants.js';
import * as M from '../utils/messages.js';

/**
 * The conversation engine.
 *
 * A "handler" is `async (ctx) => reply` where ctx carries the session, the
 * user, and the parsed message. Handlers are registered per state name; the
 * engine routes each inbound message to the handler for the session's current
 * state, applies global commands first, and sends whatever the handler returns.
 */

const handlers = new Map();

/** Register a state handler. */
export function on(state, handler) {
  if (handlers.has(state)) {
    throw new Error(`Duplicate handler registered for state "${state}"`);
  }
  handlers.set(state, handler);
}

export function getHandler(state) {
  return handlers.get(state);
}

export function registeredStates() {
  return [...handlers.keys()];
}

/**
 * Reply helpers a handler returns. A handler may return:
 *   - a string                        -> send it, stay in the current state
 *   - { text, state, data, ... }      -> send + transition
 *   - an array of the above           -> send several messages in order
 *   - null/undefined                  -> send nothing
 */
export const reply = (text, state, extra = {}) => ({ text, state, ...extra });
export const goto = (state, text, extra = {}) => ({ text, state, ...extra });
export const stay = (text, extra = {}) => ({ text, ...extra });

/** Build the context object handed to every handler. */
async function buildContext({ phone, text, mediaUrl, mediaId, session }) {
  const user = session.user ? await User.findById(session.user) : null;
  return {
    phone,
    text: String(text ?? ''),
    mediaUrl,
    mediaId,
    session,
    user,
    data: session.data || {},
    command: detectCommand(text),
    /** Persist a value into the session scratch area. */
    set(key, value) {
      session.data = { ...(session.data || {}), [key]: value };
      session.markModified('data');
    },
    /** Merge several values at once. */
    merge(obj) {
      session.data = { ...(session.data || {}), ...obj };
      session.markModified('data');
    },
    get(key, fallback = undefined) {
      const v = (session.data || {})[key];
      return v === undefined ? fallback : v;
    },
  };
}

/** Main menu text for whichever role the session belongs to. */
export function mainMenuFor(role) {
  return role === USER_ROLE.NANNY ? M.NANNY_MAIN_MENU : M.FAMILY_MAIN_MENU;
}

export function mainMenuState(role) {
  return role === USER_ROLE.NANNY ? 'NANNY_MAIN_MENU' : 'FAMILY_MAIN_MENU';
}

/**
 * Global commands that work from (almost) any state.
 * States that need to consume a command themselves (chat relay consuming BYE,
 * a prompt accepting "None") opt out via `allowCommands`.
 */
async function handleGlobalCommand(ctx) {
  const { command, session } = ctx;
  if (!command) return null;

  // NONE / NEXT / SKIP are state-specific; handlers deal with them.
  if (['NONE', 'NEXT', 'SKIP'].includes(command)) return null;

  // A full reset: back to the very first question, as if they had just
  // messaged for the first time. Role is cleared too, so someone who picked
  // the wrong side can switch.
  if (command === 'RESTART') {
    session.reset('START');
    session.role = undefined;
    session.user = undefined;
    const { restartHandler } = await import('./common.js');
    return restartHandler(ctx);
  }

  if (command === 'MAIN_MENU') {
    const state = mainMenuState(session.role);
    session.reset(state);
    return { text: mainMenuFor(session.role), state };
  }

  if (command === 'BACK') {
    const prev = session.pop();
    if (!prev) {
      const state = mainMenuState(session.role);
      session.reset(state);
      return { text: mainMenuFor(session.role), state };
    }
    // Re-enter the previous state by replaying its prompt.
    const handler = handlers.get(prev);
    if (handler?.prompt) {
      const text = await handler.prompt(ctx);
      return { text, state: prev, noPush: true };
    }
    return { text: mainMenuFor(session.role), state: mainMenuState(session.role) };
  }

  return null;
}

/**
 * Process one inbound WhatsApp message end to end.
 * Returns the outbound message bodies (useful for tests and the simulator).
 */
/** WhatsApp sends voice notes as 'ptt'; plain audio files come as 'audio'. */
const isVoice = (mediaType) => ['ptt', 'audio'].includes(mediaType);

/**
 * Turn a voice note into text before any handler sees it.
 *
 * The bot invites voice messages for the long free-text questions, so the
 * transcript has to arrive as ordinary text — otherwise the handler waiting
 * for an answer just sees an attachment and asks again.
 *
 * Returns the text to use, plus an optional note to send back when we could
 * not transcribe. Never throws: a failed transcription asks the family to
 * type instead of breaking the booking they are part-way through.
 */
async function resolveVoiceNote({ text, mediaUrl, mediaType }) {
  if (!isVoice(mediaType) || !mediaUrl) return { text, notice: null };

  // A caption alongside the audio is what they meant to say.
  if (String(text || '').trim()) return { text, notice: null };

  const { getSetting } = await import('../services/settings.js');
  const { transcribe, isConfigured } = await import('../providers/transcription.js');

  const enabled = await getSetting('voiceTranscription').catch(() => true);
  if (!enabled || !isConfigured()) {
    return {
      text: '',
      notice: '\u{1F3A4} Sorry, I cannot listen to voice messages right now. Please type your answer instead.',
    };
  }

  const config = (await import('../config/index.js')).default;
  const transcript = await transcribe(mediaUrl, { language: config.transcription.language || undefined });

  if (!transcript) {
    return {
      text: '',
      notice: '\u{1F3A4} I could not make out that voice message. Please try again, or type your answer.',
    };
  }

  return { text: transcript, notice: null, transcribed: true };
}

export async function handleMessage({ phone: rawPhone, text = '', mediaUrl, mediaId, mediaType }) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return [];

  let session = await Session.findOne({ phone });
  if (!session) session = await Session.create({ phone, state: 'START' });

  session.lastMessageAt = new Date();

  const voice = await resolveVoiceNote({ text, mediaUrl, mediaType });

  // A transcribed note continues as text, so the media is not passed on:
  // handlers that require an attachment (an ID photo, a receipt) must not
  // accept a voice message as one.
  const effectiveText = voice.text;
  const effectiveMedia = voice.transcribed ? undefined : mediaUrl;

  await MessageLog.create({
    direction: 'in',
    phone,
    // Keep the transcript in the log so the dashboard shows what was said.
    body: voice.transcribed ? `\u{1F3A4} ${effectiveText}` : text,
    mediaUrl,
    state: session.state,
    role: session.role,
  }).catch(() => {});

  // Could not transcribe: say so and leave the conversation where it was.
  if (voice.notice) {
    await session.save();
    const ctxForPrompt = await buildContext({ phone, text: '', session });
    const handler = handlers.get(session.state);
    const prompt = handler?.prompt ? await handler.prompt(ctxForPrompt) : null;
    const bodies = [voice.notice, prompt].filter(Boolean);
    for (const body of bodies) {
      // eslint-disable-next-line no-await-in-loop
      await sendText(phone, body, { role: session.role, state: session.state }).catch(() => {});
    }
    return bodies;
  }

  const ctx = await buildContext({
    phone, text: effectiveText, mediaUrl: effectiveMedia, mediaId, session,
  });

  let result;
  try {
    const handler = handlers.get(session.state) || handlers.get('START');

    // Global commands run first unless the state opts out.
    if (!handler?.allowCommands) {
      const globalResult = await handleGlobalCommand(ctx);
      result = globalResult ?? (handler ? await callHandler(handler, ctx) : null);
    } else {
      result = handler ? await callHandler(handler, ctx) : null;
    }
  } catch (err) {
    console.error(`[engine] handler error in state ${session.state}:`, err);
    result = {
      text: '⚠️ Something went wrong on our side. Please try again, or type *0* for the main menu.',
    };
  }

  const outbound = await applyResult(session, result, ctx);
  await session.save();
  return outbound;
}

async function callHandler(handler, ctx) {
  return typeof handler === 'function' ? handler(ctx) : handler.handle(ctx);
}

/** Apply a handler's return value: transition the session and send messages. */
async function applyResult(session, result, ctx) {
  if (!result) return [];
  const items = Array.isArray(result) ? result : [result];
  const bodies = [];

  for (const item of items) {
    if (!item) continue;
    const node = typeof item === 'string' ? { text: item } : item;

    if (node.state && node.state !== session.state) {
      if (node.noPush) session.state = node.state;
      else session.push(node.state);
    }
    if (node.data) {
      session.data = { ...(session.data || {}), ...node.data };
      session.markModified('data');
    }
    if (node.resetData) {
      session.data = {};
      session.markModified('data');
    }
    if (node.clearStack) session.stack = [];
    if (node.listing !== undefined) session.listing = node.listing;
    if (node.activeChat !== undefined) session.activeChat = node.activeChat;
    if (node.role) session.role = node.role;
    if (node.user) session.user = node.user;

    if (node.text) {
      bodies.push(node.text);
      session.lastBotMessage = node.text;
      try {
        await sendText(session.phone, node.text, { role: session.role, state: session.state });
      } catch (err) {
        console.error(`[engine] send failed to ${session.phone}: ${err.message}`);
      }
    }
  }
  return bodies;
}

export default { on, handleMessage, reply, goto, stay, mainMenuFor, mainMenuState, registeredStates };
