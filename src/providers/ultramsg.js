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
export async function sendText(to, body, meta = {}) {
  const phone = normalizePhone(to);
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

export async function sendImage(to, imageUrl, caption = '') {
  const phone = normalizePhone(to);
  if (dry()) {
    outbox.push({ to: phone, image: imageUrl, body: caption, at: new Date() });
    return { dry: true };
  }
  return post('messages/image', { to: phone, image: imageUrl, caption });
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
