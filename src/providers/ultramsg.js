import axios from 'axios';
import config from '../config/index.js';
import MessageLog from '../models/MessageLog.js';

/**
 * UltraMsg WhatsApp gateway.
 * Docs: https://docs.ultramsg.com  (POST {base}/{instance}/messages/chat)
 *
 * When credentials are absent (local dev / tests) we run in "dry" mode:
 * messages are logged and captured instead of being sent.
 */
const dry = () => {
  // Read the environment at call time so tests (and runtime credential changes)
  // are honoured even though config was captured at import time.
  const id = process.env.ULTRAMSG_INSTANCE_ID ?? config.ultramsg.instanceId;
  const token = process.env.ULTRAMSG_TOKEN ?? config.ultramsg.token;
  return !id || !token;
};

// Captured outbound messages in dry mode — used by the simulator and tests.
export const outbox = [];

function endpoint(path) {
  return `${config.ultramsg.baseUrl}/${config.ultramsg.instanceId}/${path}`;
}

/** UltraMsg expects a bare international number (no '+', no '@c.us'). */
export function normalizePhone(input = '') {
  return String(input).replace(/@c\.us$/i, '').replace(/\D/g, '');
}

async function post(path, payload) {
  const { data } = await axios.post(
    endpoint(path),
    new URLSearchParams({ token: config.ultramsg.token, ...payload }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 }
  );
  return data;
}

/**
 * Send a text message. Long bodies are split on the WhatsApp-safe boundary so
 * the long booking summaries in the script are never silently truncated.
 */
/**
 * Numbers that must never receive a message.
 *
 * 999 is not an assigned country code, so seeded accounts use it and nothing
 * addressed there could reach a person. Dropping them here rather than only in
 * the seed is the part that matters: this is the single point every outbound
 * message passes through, so a test run, a broadcast, or a scheduler job
 * sweeping every nanny cannot message anyone by mistake — whatever wrote the
 * number, whenever.
 */
const UNROUTABLE = /^999/;

export async function sendText(to, body, meta = {}) {
  const phone = normalizePhone(to);

  /**
   * Put the message in the reader's language before anything else happens.
   *
   * Done here rather than in each flow because this is the one point every
   * outbound message passes through — flows, schedulers, broadcasts and
   * reminders alike. A message added next year is translated without anyone
   * remembering to do it, which is the only way a translation layer stays
   * complete.
   *
   * `meta.locale` is passed by the caller that already knows who it is
   * writing to. Absent, or English, and the text goes out as written.
   */
  let text = String(body ?? '');

  // Vary the wording before anything else touches it.
  //
  // Ordered before translation deliberately: the phrasebook is written in
  // English and matches on the English text, so a message translated first
  // would never be recognised. Reword, then translate whatever came out.
  if (!meta.noTranslate) {
    try {
      const { reword } = await import('../services/phrasebook.js');
      text = await reword(text);
    } catch (err) {
      // Cosmetic. Never a reason for a message not to arrive.
      console.error(`[ultramsg] rewording skipped: ${err.message}`);
    }
  }

  // The language picker is already written in every language it offers;
  // translating it would render the other eleven options unreadable to the
  // one person who needs them.
  if (meta.locale && meta.locale !== 'en' && !meta.noTranslate) {
    try {
      const { translate } = await import('../services/translate.js');
      text = await translate(text, meta.locale);
    } catch (err) {
      // A translation failure must never swallow the message itself.
      console.error(`[ultramsg] translation skipped: ${err.message}`);
    }
  }
  body = text;

  if (UNROUTABLE.test(phone)) {
    // Logged, not silent: a seeded account that should have been a real one is
    // worth noticing, and the conversation still shows in the dashboard.
    outbox.push({ to: phone, body: String(body ?? ''), at: new Date(), blocked: true });
    await log('out', phone, String(body ?? ''), meta, null, null);
    return [{ blocked: true, to: phone, reason: 'seeded test number' }];
  }

  const chunks = splitMessage(String(body ?? '').trim());
  const results = [];

  for (const chunk of chunks) {
    if (!chunk) continue;
    if (dry()) {
      outbox.push({ to: phone, body: chunk, at: new Date() });
      results.push({ dry: true, to: phone, body: chunk });
      await log('out', phone, chunk, meta, null, null);
      continue;
    }
    try {
      const data = await post('messages/chat', { to: phone, body: chunk });
      results.push(data);
      await log('out', phone, chunk, meta, data?.id, null);
    } catch (err) {
      const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      await log('out', phone, chunk, meta, null, msg);
      throw err;
    }
  }
  return results;
}

/**
 * Turn a stored media path into something WhatsApp can actually fetch.
 *
 * Media is archived under a relative path so the dashboard keeps working
 * whatever host it is served from. UltraMsg cannot use that: it downloads the
 * file from our server, so it needs an absolute public URL. Anything already
 * absolute is passed straight through.
 *
 * Returns null when there is no usable public address, so the caller can skip
 * the send rather than hand the provider a localhost link it will never reach.
 */
export function publicMediaUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;

  const base = String(config.publicBaseUrl || '').replace(/\/+$/, '');
  if (!base || /localhost|127\.0\.0\.1/i.test(base)) return null;

  return `${base}/${raw.replace(/^\/+/, '')}`;
}

export async function sendImage(to, imageUrl, caption = '') {
  const phone = normalizePhone(to);
  const url = publicMediaUrl(imageUrl);
  if (!url) throw new Error(`no public URL for image ${imageUrl} (set PUBLIC_BASE_URL)`);
  if (dry()) {
    outbox.push({ to: phone, image: url, body: caption, at: new Date() });
    return { dry: true };
  }
  return post('messages/image', { to: phone, image: url, caption });
}

export async function sendVideo(to, videoUrl, caption = '') {
  const phone = normalizePhone(to);
  const url = publicMediaUrl(videoUrl);
  if (!url) throw new Error(`no public URL for video ${videoUrl} (set PUBLIC_BASE_URL)`);
  if (dry()) {
    outbox.push({ to: phone, video: url, body: caption, at: new Date() });
    return { dry: true };
  }
  return post('messages/video', { to: phone, video: url, caption });
}

export async function sendDocument(to, documentUrl, filename = 'document.pdf', caption = '') {
  const phone = normalizePhone(to);
  if (dry()) {
    outbox.push({ to: phone, document: documentUrl, filename, body: caption, at: new Date() });
    return { dry: true };
  }
  return post('messages/document', { to: phone, document: documentUrl, filename, caption });
}

/** WhatsApp caps a message around 4096 chars; split on paragraph/line breaks. */
export function splitMessage(text, limit = 3800) {
  if (text.length <= limit) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = remaining.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = remaining.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

async function log(direction, phone, body, meta, providerId, error) {
  try {
    await MessageLog.create({
      direction, phone, body,
      role: meta.role, state: meta.state,
      providerId: providerId || undefined,
      error: error || undefined,
    });
  } catch {
    // Logging must never break message delivery.
  }
}

export function isDryRun() { return dry(); }

export default { sendText, sendImage, sendDocument, normalizePhone, splitMessage, isDryRun, outbox };
