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
 * "call me at eight one two..." becomes digits before the number check.
 *
 * Only a run of them counts. "I have one child and two dogs" is a sentence, and
 * folding every number word wherever it appeared meant eight scattered ones
 * added up to something the phone-number pattern matched — so an innocuous
 * message was classified as a number and, worse, replaced wholesale. The guard
 * that was supposed to prevent this read `run >= 0`, which is true for every
 * possible value of `run`.
 */
const MIN_SPELLED_RUN = 4;

function foldSpelledDigits(text) {
  const words = text.split(/(\s+)/);
  let run = 0;
  let longestRun = 0;
  const out = words.map((w) => {
    const key = w.toLowerCase().replace(/[^a-z]/g, '');
    if (DIGIT_WORDS[key] !== undefined) {
      run += 1;
      if (run > longestRun) longestRun = run;
      return DIGIT_WORDS[key];
    }
    if (w.trim()) run = 0;
    return w;
  });
  return longestRun >= MIN_SPELLED_RUN ? out.join('') : text;
}

/** Digits once separators people use to dodge filters are removed. */
const digitsOnly = (s) => s.replace(/[\s.\-()+_/\\]/g, '');

/**
 * `flat` is the message with separators stripped, and only the digit check may
 * read it. Stripping spaces joins ordinary words — "meet me @ the gate at 8.30"
 * becomes "meetme@thegateat830" — which looks exactly like an email or a handle
 * to the other two patterns.
 */
const PATTERNS = [
  // A run of digits long enough to be a phone number, however spaced out.
  {
    test: (s) => /(?:\d[\s.\-()+_]*){8,}/.test(s),
    label: 'phone number',
    stripped: true,
  },
  // Email addresses.
  {
    test: (s) => /[\w.+-]+@[\w-]+\.[\w.]{2,}/i.test(s),
    label: 'email address',
  },
  /**
   * Messaging handles and links people swap instead of a number.
   *
   * Kept in step with the replacements below: a platform detected here and not
   * removable there used to fall through to replacing the whole message.
   * Snapchat and Facebook were missing from this list while being removable,
   * which is the same mismatch the other way round.
   *
   * The bare @handle is its own alternative rather than living inside the
   * `\b(...)\b` group, where the trailing boundary let "@ the gate" match.
   */
  {
    test: (s) => /\b(?:wa\.me|whatsapp\.com|t\.me|telegram|instagram|ig|line\s*id|wechat|signal|snapchat|facebook|fb)\b/i.test(s)
      || /@[a-z0-9._]{3,}/i.test(s),
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
    .filter((p) => p.test(original) || p.test(folded) || (p.stripped && p.test(flat)))
    .map((p) => p.label);

  if (!kinds.length) return { text: original, redacted: false, kinds: [] };

  /**
   * Replace the contact detail, never the message around it.
   *
   * Every pattern that can raise a flag above has a replacement here. It used
   * to detect a handle — instagram, telegram, signal, an @name — and have no
   * rule to remove one, so the fallback below fired and the entire message
   * became "[removed]". A family writing "Aisha has a peanut allergy and
   * carries an EpiPen. Telegram me if problems" had the allergy deleted and the
   * nanny was shown a single word.
   */
  let safe = original
    .replace(/[\w.+-]+@[\w-]+\.[\w.]{2,}/gi, '[removed]')
    .replace(/(?:\d[\s.\-()+_]*){8,}/g, '[removed]')
    .replace(/\b(?:wa\.me|whatsapp\.com|t\.me|telegram\.me)\S*/gi, '[removed]')
    // A platform named, with whatever identifier trails it.
    .replace(
      /\b(?:telegram|instagram|ig|line\s*id|wechat|signal|snapchat|facebook|fb)\b[:\s]*@?[a-z0-9._-]*/gi,
      '[removed]',
    )
    // A bare @handle. Three characters or more, so "@ the gate" survives.
    .replace(/@[a-z0-9._]{3,}/gi, '[removed]');

  /**
   * A flag with nothing replaced means the spelled-out form was what matched.
   * The digits live in the words themselves, so they are folded back and cut
   * from the real text — the rest of the sentence still reaches the recipient.
   */
  if (safe === original) {
    safe = original.replace(
      new RegExp(`(?:\\b(?:${Object.keys(DIGIT_WORDS).join('|')})\\b[\\s.,-]*){${MIN_SPELLED_RUN},}`, 'gi'),
      '[removed] ',
    ).trim();
  }

  // Nothing identifiable left to keep: the message was the contact detail.
  if (safe === original) safe = '[removed]';

  return { text: safe, redacted: true, kinds: [...new Set(kinds)] };
}

export const CONTACT_BLOCKED_NOTICE =
  '\u{1F512} For everyone\u{2019}s safety, phone numbers and other contact details are '
  + 'removed from messages. Please keep the conversation here \u{2014} we relay everything both ways.';

export default { redactContactDetails, CONTACT_BLOCKED_NOTICE };
