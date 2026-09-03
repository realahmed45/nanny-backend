import { Setting } from '../models/index.js';

/**
 * Runtime settings, cached in memory.
 *
 * These are read on the hot path — every inbound voice note checks whether
 * transcription is on — so hitting the database each time would be wasteful.
 * The cache is short-lived rather than permanent so a change made in the
 * dashboard takes effect promptly without needing a restart.
 */
const TTL_MS = 30_000;

/** Defaults used until an admin overrides them. */
export const DEFAULTS = {
  voiceTranscription: true,
  // Set in the dashboard; see services/pricing.js for the shape.
  pricing: null,
  referralDiscount: null,
};

let cache = null;
let cachedAt = 0;

/** Drop the cache so the next read reflects a change immediately. */
export function invalidateSettings() {
  cache = null;
  cachedAt = 0;
}

export async function getSettings() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;

  const rows = await Setting.find({}).lean().catch(() => []);
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  cache = { ...DEFAULTS, ...stored };
  cachedAt = Date.now();
  return cache;
}

/** One setting, with its default applied. */
export async function getSetting(key) {
  const all = await getSettings();
  return all[key];
}

export async function setSetting(key, value, adminId = null) {
  await Setting.findOneAndUpdate(
    { key },
    { key, value, updatedBy: adminId },
    { upsert: true, new: true },
  );
  invalidateSettings();
  return value;
}

export default { getSettings, getSetting, setSetting, invalidateSettings, DEFAULTS };
