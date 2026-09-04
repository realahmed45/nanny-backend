import crypto from 'crypto';
import { ShareLink, ShareLinkClick, User, SKIP_REASON } from '../models/index.js';
import { getSettings } from './settings.js';
import config from '../config/index.js';

/**
 * Minting, reading and parsing share links.
 *
 * A link is a dated claim: it says who shared, when, and for how long that
 * share can still earn them anything. The sharer's own referralCode is
 * permanent and identifies them; this is the thing with a deadline on it.
 */

/** No I, O, 0 or 1 — a code gets read aloud and retyped from screenshots. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const DEFAULTS = {
  expiryDays: 30,          // OR5
  codeLength: 22,
  /** How long a coded message may adopt an orphaned redirect row. */
  pairWindowMinutes: 30,
};

/** Settings screen beats the environment, which beats the constant. */
async function tunables() {
  const settings = await getSettings().catch(() => ({}));
  const num = (a, b, fallback) => {
    const v = Number(a ?? b);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    expiryDays: num(settings.shareLinkExpiryDays, process.env.SHARELINK_EXPIRY_DAYS, DEFAULTS.expiryDays),
    codeLength: num(null, process.env.SHARELINK_CODE_LENGTH, DEFAULTS.codeLength),
    pairWindowMinutes: num(null, process.env.SHARELINK_PAIR_WINDOW_MIN, DEFAULTS.pairWindowMinutes),
  };
}

function generateCode(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/**
 * Reduce anything to the code alphabet before it reaches a lookup.
 *
 * Express decodes %2F inside a route parameter, so `:linkId` can arrive
 * carrying `../../`. Canonicalising first is what stops that mattering.
 */
export function canonCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Find a link code inside an inbound message.
 *
 * Accepts the prefilled form ("nanny ABC…"), a bare code, and the older
 * `[ref:CODE]` marker. The length floor is what stops an ordinary word ever
 * matching — without it, "NANNY" itself would look like a code.
 */
export function parseLinkId(body, minLength = 10) {
  const text = String(body || '');

  const marker = text.match(/\[ref:([A-Za-z0-9]+)\]/i);
  if (marker) return canonCode(marker[1]);

  const words = text.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const candidate = words.find((w) => w.length >= minLength && /^[A-Z0-9]+$/.test(w));
  return candidate ? canonCode(candidate) : null;
}

/** Where a tracked link points. Empty base means no tracked URL at all. */
function buildTrackedUrl(code) {
  const base = String(config.publicBaseUrl || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return '';
  return `${base}/r/${code}`;
}

function buildWaUrl(code, extra = '') {
  const number = config.referral?.whatsappNumber;
  if (!number) return '';
  const text = encodeURIComponent(`nanny ${code}${extra ? ` ${extra}` : ''}`);
  return `https://wa.me/${number}?text=${text}`;
}

/**
 * Mint a link. OR5 and OR6 are both decided here, once.
 */
export async function createShareLink({ sharer, kind = 'general', nanny = null }) {
  const { expiryDays, codeLength } = await tunables();

  // Collisions are vanishingly unlikely at 22 chars, but a duplicate key
  // here would surface as a failed share rather than a wrong one.
  let linkId;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    linkId = generateCode(codeLength);
    // eslint-disable-next-line no-await-in-loop
    if (!(await ShareLink.exists({ linkId }))) break;
  }

  const expiresAt = new Date(Date.now() + expiryDays * 86400000);

  return ShareLink.create({
    linkId,
    sharer: sharer._id,
    sharerCode: sharer.referralCode,
    sharerPhone: sharer.phone,
    kind,
    nanny: nanny?._id,
    trackedUrl: buildTrackedUrl(linkId),
    waUrl: buildWaUrl(linkId, nanny ? `N${nanny._id}` : ''),
    expiresAt,
  });
}

/** The link behind a code, or null. Never throws on a malformed code. */
export async function findLink(code) {
  const clean = canonCode(code);
  if (!clean) return null;
  return ShareLink.findOne({ linkId: clean });
}

/**
 * OR1 — record a click.
 *
 * One human tap fires twice: the redirect logs a row with no phone (it cannot
 * know one yet), then the prefilled message arrives carrying the same code.
 * The second adopts the first rather than logging again — otherwise the tap
 * is double-counted and the phone-less row sits in "clicked, never replied"
 * forever, describing someone who replied seconds later.
 */
export async function recordClick(code, phone = '', { source = 'web_redirect', userAgent, ip } = {}) {
  const link = await findLink(code);
  if (!link) return null;

  const { pairWindowMinutes } = await tunables();
  const cleanPhone = String(phone || '').replace(/\D/g, '');

  // A message carrying a code looks for the redirect row it belongs to.
  if (cleanPhone) {
    const since = new Date(Date.now() - pairWindowMinutes * 60000);
    const orphan = await ShareLinkClick.findOne({
      linkId: link.linkId,
      clickerPhone: '',
      createdAt: { $gte: since },
    }).sort({ createdAt: -1 });

    if (orphan) {
      orphan.clickerPhone = cleanPhone;
      orphan.matchConfidence = 'certain';
      orphan.confirmedByMessageAt = new Date();
      // openCount stays as it was: one tap, one open.
      await orphan.save();
      return orphan;
    }
  }

  const isSelf = cleanPhone && cleanPhone === String(link.sharerPhone || '').replace(/\D/g, '');

  const click = await ShareLinkClick.create({
    linkId: link.linkId,
    shareLink: link._id,
    sharer: link.sharer,
    clickerPhone: cleanPhone,
    source,
    matchConfidence: cleanPhone ? 'certain' : 'none',
    confirmedByMessageAt: cleanPhone ? new Date() : undefined,
    skipReason: isSelf ? SKIP_REASON.SELF_CLICK : SKIP_REASON.NO_INTERACTION,
    userAgent,
    ip,
  });

  link.openCount = (link.openCount || 0) + 1;
  await link.save();

  return click;
}

/**
 * Called on every inbound message, before any routing.
 *
 * Purely passive: it records and returns, never replies and never alters the
 * conversation. A message with no code in it costs one regex.
 */
export async function recordInboundOpen(phone, body) {
  const code = parseLinkId(body);
  if (!code) return null;
  return recordClick(code, phone, { source: 'inbound_message' }).catch(() => null);
}

/** Close links whose window has passed, so reports stop counting them live. */
export async function expireLinks(now = new Date()) {
  const { modifiedCount } = await ShareLink.updateMany(
    { status: 'active', expiresAt: { $lte: now } },
    { $set: { status: 'expired' } },
  );
  return modifiedCount || 0;
}

export default {
  createShareLink, recordClick, recordInboundOpen, findLink,
  parseLinkId, canonCode, expireLinks, DEFAULTS,
};
