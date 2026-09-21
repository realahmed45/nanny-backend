/**
 * The languages the bot speaks.
 *
 * A nanny platform is used by two groups who rarely share a first language:
 * families who are often expatriates, and nannies who are often not. Making
 * both use English is a tax on whoever is less comfortable in it, and in
 * practice that is usually the nanny — the person with the least room to
 * push back.
 *
 * Kept deliberately separate from `LANGUAGES` in constants.js, which is a
 * different thing entirely: that is the list of languages a nanny *speaks*,
 * used as a search filter by families. This is the language the bot *writes
 * in*. Conflating the two would mean a family searching for an Arabic-speaking
 * nanny silently switched the interface to Arabic.
 */

/**
 * Locale code -> how it is offered and rendered.
 *
 * `native` is what appears in the picker, because someone who does not read
 * English cannot find "Spanish" in a list — they are looking for "Español".
 *
 * `rtl` drives nothing automatically in WhatsApp, which renders right-to-left
 * text correctly on its own. It is recorded because anything we generate
 * ourselves — a PDF, a profile card, the admin dashboard — does need to know.
 */
export const LOCALES = {
  en: { native: 'English', english: 'English', rtl: false },
  id: { native: 'Bahasa Indonesia', english: 'Indonesian', rtl: false },
  es: { native: 'Español', english: 'Spanish', rtl: false },
  pt: { native: 'Português', english: 'Portuguese', rtl: false },
  fr: { native: 'Français', english: 'French', rtl: false },
  de: { native: 'Deutsch', english: 'German', rtl: false },
  ru: { native: 'Русский', english: 'Russian', rtl: false },
  ar: { native: 'العربية', english: 'Arabic', rtl: true },
  'zh-CN': { native: '简体中文', english: 'Chinese (Simplified)', rtl: false },
  'zh-TW': { native: '繁體中文', english: 'Chinese (Traditional)', rtl: false },
  ja: { native: '日本語', english: 'Japanese', rtl: false },
  ko: { native: '한국어', english: 'Korean', rtl: false },
};

export const LOCALE_CODES = Object.keys(LOCALES);

/**
 * English, when nothing else is known.
 *
 * Not because it is more important, but because it is the one language every
 * string in the codebase is already written in, so it is the only fallback
 * guaranteed to produce a complete message rather than a half-translated one.
 */
export const DEFAULT_LOCALE = 'en';

/** Is this a locale we actually speak? Guards anything read from a database. */
export function isSupported(code) {
  return Object.prototype.hasOwnProperty.call(LOCALES, code);
}

/**
 * Settle on a usable locale.
 *
 * A stored preference can outlive the language it names — a locale dropped
 * from the list, a value typed by hand into the database, a column migrated
 * from somewhere else. Falling back to English beats sending someone a
 * message built from `undefined`.
 */
export function resolveLocale(code) {
  if (!code) return DEFAULT_LOCALE;
  const exact = String(code).trim();
  if (isSupported(exact)) return exact;

  // "es-MX" and "es-419" are Spanish. Matching on the base subtag means a
  // locale arriving from a phone's settings or a browser header still lands
  // somewhere sensible rather than defaulting to English.
  const base = exact.split(/[-_]/)[0].toLowerCase();
  if (isSupported(base)) return base;

  // Chinese is the exception: zh alone does not say which script, and the two
  // are not mutually readable. Simplified is the larger readership, so an
  // unqualified "zh" goes there rather than being dropped to English.
  if (base === 'zh') return 'zh-CN';

  return DEFAULT_LOCALE;
}

/** The picker, as a numbered list. Native names only — see `native` above. */
export function languageMenu() {
  return LOCALE_CODES
    .map((code, i) => `${i + 1}. ${LOCALES[code].native}`)
    .join('\n');
}

/** Turn a reply to that menu back into a locale code. */
export function localeFromMenuChoice(input) {
  const n = Number(String(input).trim());
  if (Number.isInteger(n) && n >= 1 && n <= LOCALE_CODES.length) {
    return LOCALE_CODES[n - 1];
  }

  // People answer a language menu by naming the language, in either its own
  // name or in English. Both are accepted, because being told "that is not a
  // valid option" in a language you do not read is a dead end.
  const typed = String(input).trim().toLowerCase();
  for (const [code, meta] of Object.entries(LOCALES)) {
    if (typed === meta.native.toLowerCase()) return code;
    if (typed === meta.english.toLowerCase()) return code;
    if (typed === code.toLowerCase()) return code;
  }
  return null;
}

export default { LOCALES, LOCALE_CODES, DEFAULT_LOCALE, isSupported, resolveLocale, languageMenu, localeFromMenuChoice };
