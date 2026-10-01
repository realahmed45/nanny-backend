/**
 * Strip contact details out of relayed chat messages.
 *
 * Families and nannies talk through us so neither sees the other's number.
 * That protection is worth nothing if either side can simply type their number
 * into the chat, so outgoing relays are redacted.
 *
 * People who want to share a number will try to get around a filter, so the
 * matching is deliberately loose: digits separated by spaces, dots or dashes,
 * spelled-out digits, and the usual "add me on..." handles all count.
 */

const DIGIT_WORDS = {
  zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  oh: '0', nol: '0', satu: '1', dua: '2', tiga: '3', empat: '4',
  lima: '5', enam: '6', tujuh: '7', delapan: '8', sembilan: '9',
};

/**
 * Joining words people drop between spelled-out digits to dodge the filter:
 * "eight one two three and four five six seven". They only ever join two
 * *spelled* digits. Between numerals they would turn "10.00 and 14.00" into
 * eight digits, and a medicine schedule into a "phone number".
 */
const JOINERS = new Set([
  'then', 'and', 'dan', 'lalu', 'kemudian', 'terus', 'next', 'after', 'plus', 'dash', 'strip',
]);

/** Fewest digits that count as a phone number. */
const MIN_PHONE_DIGITS = 8;

/**
 * Spelled digit words scattered through a message that never formed a single
 * locatable number. Reported (in `kinds`) so a caller can flag it, but nothing
 * is removed: there is no span to cut, and cutting more would destroy the
 * message around it.
 */
const MIN_SCATTERED_SPELLED = 8;

/**
 * Whitespace-delimited tokens that are ordinary numbers in this chat — times,
 * dates, prices — and must never be merged with their neighbours into a phone
 * number. "Kids eat at 12.30 18.30" is two meal times, not eight digits.
 */
const TIME = /^\d{1,2}[.:]\d{2}(?:[.:]\d{2})?(?:am|pm|wib|wita|wit|h)?$/i;
const DATE_DMY = /^\d{1,2}[./-]\d{1,2}[./-](?:\d{2}|(?:19|20)\d{2})$/;
const DATE_YMD = /^(?:19|20)\d{2}[./-]\d{1,2}[./-]\d{1,2}$/;
const PRICE = /^(?:rp\.?|idr)?[1-9]\d{0,2}(?:[.,]\d{3})+(?:[.,]\d{1,2})?$/i;
const PRICE_PREFIX = /^(?:rp\.?|idr)$/i;
/** A span like "12 10 2026" is a date written with spaces, not a number. */
const SPACED_DATE = /^\d{1,2}[\s./-]+\d{1,2}[\s./-]+(?:19|20)\d{2}$/;

function isProtectedToken(core, prev) {
  if (TIME.test(core) || DATE_DMY.test(core) || DATE_YMD.test(core)) return true;
  if (!PRICE.test(core)) return false;
  // "Rp 150.000", "Rp150.000", or a round amount like "1.500.000". A bare
  // "812.345.678" is shaped like a price too, but is far likelier a number.
  return PRICE_PREFIX.test(prev) || /^(?:rp|idr)/i.test(core) || /[.,]000$/.test(core);
}

/** Character ranges of the original text that hold protected tokens. */
function protectedRanges(text) {
  const ranges = [];
  let prev = '';
  for (const m of text.matchAll(/\S+/g)) {
    const raw = m[0];
    const lead = raw.match(/^[(\["'{]*/)[0].length;
    const trail = raw.slice(lead).match(/[.,;:!?)\]}"']*$/)[0].length;
    const core = raw.slice(lead, raw.length - trail);
    if (core && isProtectedToken(core, prev)) {
      ranges.push([m.index + lead, m.index + raw.length - trail]);
    }
    prev = core;
  }
  return ranges;
}

/**
 * Locate phone numbers in the text, as [start, end) spans.
 *
 * Detection and location are the same pass, so every number found is a number
 * that can be cut out in place. The filter used to detect on a flattened copy
 * of the message (spaces, dots and "and" all stripped) and then fail to find
 * those digits in the real text — and fall back to replacing the entire
 * message with "[removed]", allergy instructions and all.
 *
 * A number is a run of units — numerals or spelled digit words — joined only by
 * the separators people put *inside* one number: spaces, dots, dashes,
 * brackets, plus, underscore. Commas and joining words ("and", "dan", "then")
 * only join spelled digits to spelled digits. Times, dates and prices are
 * walls, never units.
 */
function findPhoneSpans(text) {
  const walls = protectedRanges(text);
  const inWall = (i) => walls.some(([a, b]) => i >= a && i < b);
  const spans = [];
  let spelledTotal = 0;
  let spelledInSpans = 0;

  let span = null;
  let pendingWord = false; // a comma or joining word since the last unit

  const close = () => {
    if (span && span.digits >= MIN_PHONE_DIGITS) {
      let { start } = span;
      while (start > 0 && /[+(]/.test(text[start - 1])) start -= 1;
      const body = text.slice(start, span.end);
      if (!SPACED_DATE.test(body.trim())) {
        spans.push([start, span.end]);
        spelledInSpans += span.spelled;
      }
    }
    span = null;
    pendingWord = false;
  };

  for (const m of text.matchAll(/\d+|[A-Za-z]+|\s+|[^\dA-Za-z\s]/g)) {
    const lex = m[0];
    const start = m.index;
    const end = start + lex.length;
    const lower = lex.toLowerCase();
    const isNumeral = /^\d/.test(lex) && !inWall(start);
    const isSpelled = DIGIT_WORDS[lower] !== undefined;

    if (isSpelled) spelledTotal += 1;

    if (isNumeral || isSpelled) {
      if (span && pendingWord && !(span.lastSpelled && isSpelled)) close();
      if (!span) span = { start, end, digits: 0, spelled: 0, lastSpelled: false };
      span.end = end;
      span.digits += isNumeral ? lex.length : 1;
      if (isSpelled) span.spelled += 1;
      span.lastSpelled = isSpelled;
      pendingWord = false;
      continue;
    }

    if (!span) continue;
    if (/^\s+$/.test(lex) || /^[.\-()+_]$/.test(lex)) continue;
    if ((lex === ',' || JOINERS.has(lower)) && span.lastSpelled) {
      pendingWord = true;
      continue;
    }
    close();
  }
  close();

  return { spans, scatteredSpelled: spelledTotal - spelledInSpans };
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]{2,}/gi;
const LINK = /\b(?:wa\.me|whatsapp\.com|t\.me|telegram\.me|instagram\.com|ig\.me)\S*/gi;
/**
 * A platform named, with whatever identifier trails it: "telegram me",
 * "ig: @jane", "WA saya". Only that much goes; the sentence stays.
 */
const PLATFORM = /\b(?:whatsapp|wa|telegram|instagram|ig|line\s*id|wechat|signal|snapchat|facebook|fb)\b[:\s]*@?[a-z0-9._-]*/gi;
/** A bare @handle. Three characters or more, so "@ the gate" survives. */
const HANDLE = /@[a-z0-9._]{3,}/gi;

/**
 * Redact contact details from a relayed message.
 *
 * Returns { text, redacted, kinds }: the safe text, whether anything was
 * removed (so the sender can be told rather than left wondering why the other
 * side did not reply), and what kinds of contact detail were seen.
 *
 * Only the contact detail itself is replaced, in place, with "[removed]". The
 * message around it is never touched — there is no "replace everything"
 * fallback. Something that looks suspicious but cannot be pinned to a span
 * (spelled digits scattered across a sentence) is reported in `kinds` and
 * left in the text.
 */
export function redactContactDetails(text) {
  const original = String(text || '');
  if (!original.trim()) return { text: original, redacted: false, kinds: [] };

  const kinds = [];
  const cut = (s, re, label) => s.replace(re, () => {
    kinds.push(label);
    return '[removed]';
  });

  // Emails and links first, so digits inside them are not cut out separately
  // and leave half an address behind.
  let safe = cut(original, EMAIL, 'email address');
  safe = cut(safe, LINK, 'contact handle');
  safe = cut(safe, PLATFORM, 'contact handle');
  safe = cut(safe, HANDLE, 'contact handle');

  const { spans, scatteredSpelled } = findPhoneSpans(safe);
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    const [a, b] = spans[i];
    safe = `${safe.slice(0, a)}[removed]${safe.slice(b)}`;
    kinds.push('phone number');
  }
  if (scatteredSpelled >= MIN_SCATTERED_SPELLED) kinds.push('phone number');

  return { text: safe, redacted: safe !== original, kinds: [...new Set(kinds)] };
}

export const CONTACT_BLOCKED_NOTICE =
  '\u{1F512} For everyone\u{2019}s safety, phone numbers and other contact details are '
  + 'removed from messages. Please keep the conversation here \u{2014} we relay everything both ways.';

export default { redactContactDetails, CONTACT_BLOCKED_NOTICE };
