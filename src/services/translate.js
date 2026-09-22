import crypto from 'node:crypto';
import config from '../config/index.js';
import { LOCALES, DEFAULT_LOCALE, resolveLocale } from '../utils/locales.js';
import { Translation } from '../models/index.js';

/**
 * The bot, in the reader's language.
 *
 * Every message the bot sends is written in English in the source. Rather
 * than keeping twelve parallel copies of 135 message templates — which drift
 * the moment anyone edits one and forgets the rest — each message is
 * translated on first use and then kept.
 *
 * The cost of that decision is a slow first send per phrase per language.
 * The benefit is that adding a language is a line in `locales.js`, and
 * editing an English message re-translates itself everywhere, because the
 * cache is keyed on the English text. A message nobody changed is never
 * paid for twice.
 *
 * Two rules the translation must never break, both of which cost money or
 * bookings when they do:
 *
 *   - Placeholders stay exactly as written. "{{name}}" translated into
 *     "{{nombre}}" produces a message with a literal {{nombre}} in it.
 *   - Numbered menu options keep their numbers. Someone replying "3" must
 *     get the third thing, in every language.
 */

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

const apiKey = () => config.ai?.groqKey || config.ai?.key || process.env.GROQ_API_KEY || '';
const MODEL = () => config.ai?.model || 'openai/gpt-oss-120b';

export const isConfigured = () => Boolean(apiKey());

/**
 * Translation is on the path of a reply somebody is waiting for, so it gets
 * a tight budget. A timeout falls back to English, which is worse than a
 * translation and far better than silence.
 */
const TIMEOUT_MS = 8000;

/**
 * In-process cache in front of the database.
 *
 * The same dozen menus account for most of what the bot ever says, so this
 * absorbs nearly all of the traffic and the database only sees a phrase the
 * first time each process needs it.
 */
const memory = new Map();
const MEMORY_MAX = 2000;

/** A stable key for one English phrase in one language. */
function keyFor(text, locale) {
  const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 24);
  return `${locale}:${hash}`;
}

function remember(key, value) {
  // Bounded so a long-running process cannot grow without limit. Oldest out
  // first, which for this workload means the rarely-used phrases go and the
  // menus everyone sees stay.
  if (memory.size >= MEMORY_MAX) {
    const oldest = memory.keys().next().value;
    memory.delete(oldest);
  }
  memory.set(key, value);
}

/**
 * What the model must not touch.
 *
 * Placeholders, WhatsApp markup, emoji and the leading numbers of a menu all
 * carry meaning that does not survive being translated. They are spelled out
 * rather than stripped and reinserted, because reinsertion has to guess where
 * they go and guessing wrong scrambles the sentence.
 */
const SYSTEM = `You translate WhatsApp messages for a childcare booking service.

Rules, in order of importance:
1. Keep every placeholder EXACTLY as written: {{name}}, {{date}}, {{amount}} and similar. Never translate or reorder the text inside {{ }}.
2. Keep the leading number of every numbered line exactly as it is. "3. My Profile" must stay "3. ..." — people reply with the number.
3. Keep WhatsApp markup: *bold* stays *bold*, _italic_ stays _italic_.
4. Keep emoji where they are.
5. Keep line breaks and blank lines exactly as in the original.
6. Do not add greetings, explanations, notes or quotation marks. Return only the translated message.
7. Translate naturally, as a polite service would speak to a customer — not word for word.

Return only the translated text.`;

/**
 * Translate one phrase, or return null to mean "use the English".
 *
 * Never throws. A failure anywhere on this path must degrade to English
 * rather than break a conversation someone is in the middle of.
 */
async function callModel(text, locale) {
  if (!isConfigured()) return null;

  const target = LOCALES[locale];
  if (!target) return null;

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify({
        model: MODEL(),
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Translate to ${target.english}:\n\n${text}` },
        ],
        // Zero, deliberately. A translation is not a place for invention, and
        // the same English phrase should not come back worded differently on
        // a later cache miss.
        temperature: 0,
        max_tokens: 1400,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[translate] ${res.status} for ${locale} — ${detail.slice(0, 160)}`);
      return null;
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    const out = String(choice?.message?.content || '').trim();
    if (!out) return null;

    // Cut off mid-sentence. A half message is worse than an English one.
    if (choice.finish_reason === 'length') {
      console.error(`[translate] reply truncated for ${locale}; keeping English`);
      return null;
    }

    return out;
  } catch (err) {
    console.error(`[translate] failed for ${locale}: ${err.message}`);
    return null;
  }
}

/**
 * Every placeholder that survived, and in what quantity.
 *
 * Checked rather than trusted: a dropped {{name}} produces a message with a
 * blank where a person's name should be, and a model that helpfully
 * translates {{date}} to {{fecha}} produces one with braces showing. Either
 * is worse than sending English, so either means we send English.
 */
function placeholdersIntact(source, translated) {
  const find = (s) => (String(s).match(/\{\{[^}]+\}\}/g) || []).sort();
  const a = find(source);
  const b = find(translated);
  if (a.length !== b.length) return false;
  return a.every((token, i) => token === b[i]);
}

/**
 * The numbers that start menu lines, in order.
 *
 * A menu whose options came back renumbered — or reordered — routes people to
 * the wrong thing when they reply "2", and does it silently.
 */
function menuNumbersIntact(source, translated) {
  const find = (s) => (String(s).match(/^\s*(\d+)[.)]/gm) || []).map((m) => m.trim());
  const a = find(source);
  const b = find(translated);
  if (a.length !== b.length) return false;
  return a.every((n, i) => n === b[i]);
}

/**
 * Translate `text` into `locale`, falling back to the English on any doubt.
 *
 * Cache order is memory, then database, then the model. A phrase translated
 * once is translated for every process and every restart after it.
 */
export async function translate(text, localeInput) {
  const source = String(text ?? '');
  const locale = resolveLocale(localeInput);

  if (!source.trim()) return source;
  if (locale === DEFAULT_LOCALE) return source;

  const key = keyFor(source, locale);

  const hot = memory.get(key);
  if (hot !== undefined) return hot;

  try {
    const stored = await Translation.findOne({ key }).lean();
    if (stored?.text) {
      remember(key, stored.text);
      return stored.text;
    }
  } catch (err) {
    // A cache that cannot be read is not a reason to stop translating.
    console.error(`[translate] cache read failed: ${err.message}`);
  }

  const out = await callModel(source, locale);
  if (!out) return source;

  /**
   * A validation failure is permanent, so remember it as one.
   *
   * `temperature: 0` means the same English produces the same bad output
   * every time. Without this the phrase is sent to the model again on every
   * single send — same failure, same fallback to English, but paid for in
   * full and charged against the 8-second budget of a reply somebody is
   * waiting for. A menu that trips one of these guards would put that on
   * every menu draw, for every user in that language.
   *
   * Cached in memory only, not in the database: a later model or a reworded
   * source should get a fresh attempt rather than inheriting a verdict, and
   * a process restart is a cheap enough place to re-check.
   */
  const keepEnglish = (why) => {
    console.error(`[translate] ${why} for ${locale}; keeping English`);
    remember(key, source);
    return source;
  };

  if (!placeholdersIntact(source, out)) return keepEnglish('placeholders altered');
  if (!menuNumbersIntact(source, out)) return keepEnglish('menu numbering altered');

  remember(key, out);

  try {
    // Upsert, because two messages arriving together can both miss the cache
    // and race to write the same phrase.
    await Translation.updateOne(
      { key },
      { $set: { key, locale, source, text: out, model: MODEL() } },
      { upsert: true },
    );
  } catch (err) {
    console.error(`[translate] cache write failed: ${err.message}`);
  }

  return out;
}

/** Clear the in-process cache. Used by tests and after a bulk retranslation. */
export function clearMemoryCache() {
  memory.clear();
}

/**
 * The two checks that decide whether a translation is safe to send, exposed
 * so they can be tested directly. Getting either wrong costs a booking.
 */
export const __test = { placeholdersIntact, menuNumbersIntact };

export default { translate, isConfigured, clearMemoryCache };
