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

/** "call me at eight one two..." becomes digits before the number check. */
function foldSpelledDigits(text) {
  const words = text.split(/(\s+)/);
  let run = 0;
  const out = words.map((w) => {
    const key = w.toLowerCase().replace(/[^a-z]/g, '');
    if (DIGIT_WORDS[key] !== undefined) {
      run += 1;
      return DIGIT_WORDS[key];
    }
    if (w.trim()) run = 0;
    return w;
  });
  // Only fold when several appear together; a lone "one" is just a word.
  return run >= 0 ? out.join('') : text;
}

/** Digits once separators people use to dodge filters are removed. */
const digitsOnly = (s) => s.replace(/[\s.\-()+_/\\]/g, '');

const PATTERNS = [
  // A run of digits long enough to be a phone number, however spaced out.
  {
    test: (s) => /(?:\d[\s.\-()+_]*){8,}/.test(s),
    label: 'phone number',
  },
  // Email addresses.
  {
    test: (s) => /[\w.+-]+@[\w-]+\.[\w.]{2,}/i.test(s),
    label: 'email address',
  },
  // Messaging handles and links people swap instead of a number.
  {
    test: (s) => /\b(wa\.me|whatsapp\.com|t\.me|telegram|instagram|ig\b|@[a-z0-9._]{3,}|line id|wechat|signal)\b/i.test(s),
    label: 'contact handle',
  },
];

/**
 * Redact contact details from a relayed message.
 * Returns the safe text and whether anything was removed, so the sender can be
 * told rather than left wondering why the other side did not reply.
 */
export function redactContactDetails(text) {
  const original = String(text || '');
  if (!original.trim()) return { text: original, redacted: false, kinds: [] };

  const folded = foldSpelledDigits(original);
  const flat = digitsOnly(folded);

  const kinds = PATTERNS
    .filter((p) => p.test(original) || p.test(folded) || p.test(flat))
    .map((p) => p.label);

  if (!kinds.length) return { text: original, redacted: false, kinds: [] };

  // Replace rather than drop the message: the rest of what they said still
  // matters, and a silently vanished message looks like a bug.
  let safe = original
    .replace(/[\w.+-]+@[\w-]+\.[\w.]{2,}/gi, '[removed]')
    .replace(/(?:\d[\s.\-()+_]*){8,}/g, '[removed]')
    .replace(/\b(wa\.me|whatsapp\.com|t\.me|telegram\.me)\S*/gi, '[removed]');

  if (safe === original) safe = '[removed]';

  return { text: safe, redacted: true, kinds: [...new Set(kinds)] };
}

export const CONTACT_BLOCKED_NOTICE =
  '\u{1F512} For everyone\u{2019}s safety, phone numbers and other contact details are '
  + 'removed from messages. Please keep the conversation here \u{2014} we relay everything both ways.';

export default { redactContactDetails, CONTACT_BLOCKED_NOTICE };
