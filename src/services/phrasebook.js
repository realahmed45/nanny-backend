import { Setting } from '../models/index.js';

/**
 * The bot's wording, in two registers.
 *
 * A booking flow asks the same thirty-odd questions of everybody. Asked the
 * same way every time, the bot reads like a form — and a family filling in a
 * form about their children is a family being processed rather than helped.
 *
 * So each question has alternatives. Nothing here is generated: every line is
 * written, reviewed and stored, which is the whole point. An AI rewriting a
 * question on the fly can change its meaning, drop an option or renumber a
 * menu, and nobody finds out until a booking is wrong. A fixed list cannot.
 *
 *   strict    — one wording, always. Predictable, and the right choice when
 *               a question is legal, medical or financial: "send a photo of
 *               the transfer receipt" should not be phrased four ways.
 *   flexible  — one of several, chosen at random per message, so a long
 *               conversation does not read like a machine reciting a script.
 *
 * Deliberately separate from the structured/AI conversation mode, which is
 * about how a *reply* is interpreted. This is about how a *question* is
 * worded. The two are independent: a strict-reading bot can still vary its
 * phrasing, and a flexible-reading one can still ask in a fixed way.
 *
 * Two rules every variant must keep, because breaking either costs a booking:
 *
 *   - Placeholders stay exactly as written. {{name}} is substituted later;
 *     rewriting it to {{childName}} produces a message with braces showing.
 *   - Numbered options keep their numbers and their order. Somebody replying
 *     "2" must get the second thing, whichever wording they were shown.
 */

/** The mode names, so nothing else has to spell them as strings. */
export const PHRASING = { STRICT: 'strict', FLEXIBLE: 'flexible' };

/**
 * Questions whose wording is never varied, whatever the mode.
 *
 * These carry legal, medical or money consequences, and a phrase that reads
 * as a casual alternative — "pop over a photo of the receipt" — changes what
 * someone thinks is being asked of them. Listed explicitly rather than left
 * to judgement, so adding a variant to one is a deliberate act.
 */
export const ALWAYS_STRICT = new Set([
  'ASK_OTP',
  'ASK_ID_FRONT',
  'ASK_ID_BACK',
  'ASK_PAYMENT_PROOF',
  'ASK_CHILD_MEDICAL',
  'CONFIRM_BOOKING_DETAILS',
]);

/**
 * The phrasebook.
 *
 * `strict` is the wording as it stands in messages.js — the single version
 * used when phrasing is strict. `flexible` holds the alternatives; the strict
 * wording is included among them, so flexible mode can still produce it.
 *
 * Questions that carry a numbered menu are not varied below the first line:
 * the options are generated from the catalogue at send time, and only the
 * sentence introducing them changes.
 */
export const PHRASES = {
  /* ---------------------------------------------------------------- *
   * Registration
   * ---------------------------------------------------------------- */

  ASK_FULL_NAME: {
    label: 'Asking for a full name',
    strict: "Before we begin, let's create your account.\nWhat's your full name?",
    flexible: [
      "Before we begin, let's create your account.\nWhat's your full name?",
      "Let's get you set up.\nWhat's your full name?",
      "First, your account.\nWhat name should we put on it?",
      "To get started — what's your full name?",
    ],
  },

  ASK_EMAIL: {
    label: 'Asking for an email address',
    placeholders: ['{{name}}'],
    strict: "Great {{name}}.\nWhat's your email?",
    flexible: [
      "Great {{name}}.\nWhat's your email?",
      "Thanks {{name}}. What's your email address?",
      "Lovely, {{name}}. And your email?",
      "Got it, {{name}} — what email should we use?",
    ],
  },

  ASK_ADDRESS: {
    label: 'Asking for an exact address',
    strict: 'Type your exact address.',
    flexible: [
      'Type your exact address.',
      "What's the full address?",
      'Please type the address in full.',
      'And the exact address?',
    ],
  },

  ASK_ADDRESS_LABEL: {
    label: 'Naming a saved address',
    strict: 'What would you like to call this address? Like home, office, granny home',
    flexible: [
      'What would you like to call this address? Like home, office, granny home',
      'What should we name this address? For example home, office, granny home',
      'Give this address a name — home, office, granny home, anything that helps you find it.',
      'What name should we save it under? Home, office, granny home — whatever suits.',
    ],
  },

  /* ---------------------------------------------------------------- *
   * The children
   * ---------------------------------------------------------------- */

  ASK_CHILD_NAME: {
    label: "Asking a child's name",
    placeholders: ['{{ordinal}}'],
    strict: "What is the {{ordinal}} child's name?",
    flexible: [
      "What is the {{ordinal}} child's name?",
      "And the {{ordinal}} child — what's their name?",
      "What's the {{ordinal}} child called?",
      "Name of the {{ordinal}} child?",
    ],
  },

  ASK_CHILD_AGE: {
    label: "Asking a child's age",
    placeholders: ['{{name}}'],
    // The examples are instructions, not decoration: they are what stops
    // "four and a half" arriving where a number is expected.
    strict: 'How old is {{name}}?\n\nReply with the age in years, e.g. *4*, *4y* or *4 years*.\nFor a baby you can say *6 months*.',
    flexible: [
      'How old is {{name}}?\n\nReply with the age in years, e.g. *4*, *4y* or *4 years*.\nFor a baby you can say *6 months*.',
      "And {{name}}'s age?\n\nIn years, e.g. *4*, *4y* or *4 years*. For a baby, *6 months* works.",
      'How old is {{name}}?\n\nJust the years is fine — *4*, *4y*, *4 years*. For a baby you can say *6 months*.',
    ],
  },

  ASK_CHILD_DIET: {
    label: 'Asking about dietary requirements',
    placeholders: ['{{name}}'],
    strict: 'Does {{name}} have any dietary requirements or foods to avoid?\nPlease provide the details.',
    flexible: [
      'Does {{name}} have any dietary requirements or foods to avoid?\nPlease provide the details.',
      'Any dietary needs for {{name}}, or foods to keep away from?\nPlease tell us the details.',
      'Is there anything {{name}} cannot eat, or should not?\nPlease give us the details.',
    ],
  },

  /* ---------------------------------------------------------------- *
   * The booking
   * ---------------------------------------------------------------- */

  ASK_START_TIME: {
    label: 'Asking what time a session starts',
    // The format example stays in every variant: a bare "2" is ambiguous
    // between two in the afternoon and two in the morning, and guessing
    // wrong sends a nanny out in the dark.
    strict: 'What time does the session start?\n\nUse a time like *9:00 AM* or *2:30 PM*.',
    flexible: [
      'What time does the session start?\n\nUse a time like *9:00 AM* or *2:30 PM*.',
      'What time should she arrive?\n\nSomething like *9:00 AM* or *2:30 PM*.',
      'When does the day start?\n\nPlease give a time like *9:00 AM* or *2:30 PM*.',
      'What time do you need her from?\n\nA time like *9:00 AM* or *2:30 PM*.',
    ],
  },

  ASK_OTHER_INSTRUCTIONS: {
    label: 'Asking for anything else the nanny should know',
    strict: 'Is there anything else the nanny should know about your family or children?',
    flexible: [
      'Is there anything else the nanny should know about your family or children?',
      'Anything else that would help the nanny — about your family or the children?',
      'Is there anything else we should pass on to her?',
      'Last one: anything else the nanny should know?',
    ],
  },

  /* ---------------------------------------------------------------- *
   * Menu questions.
   * Only the opening line varies; the numbered options are appended from
   * the catalogue at send time and are never touched here.
   * ---------------------------------------------------------------- */

  ASK_CHILD_COUNT: {
    label: 'Asking how many children',
    hasOptions: true,
    strict: 'How many children need care?',
    flexible: [
      'How many children need care?',
      'How many children will she be looking after?',
      'How many children are we arranging care for?',
    ],
  },

  ASK_FREQUENCY: {
    label: 'Asking how often care is needed',
    hasOptions: true,
    strict: 'How often do you need a nanny?',
    flexible: [
      'How often do you need a nanny?',
      'How regularly do you need childcare?',
      'How often would you like her?',
    ],
  },

  ASK_DURATION: {
    label: 'Asking how long the nanny is needed',
    hasOptions: true,
    strict: 'How long do you need the nanny?',
    flexible: [
      'How long do you need the nanny?',
      'How many hours do you need her for?',
      'How long should the session run?',
    ],
  },

  ASK_LANGUAGES: {
    label: 'Asking which languages the nanny should speak',
    hasOptions: true,
    strict: 'Choose a language.',
    flexible: [
      'Choose a language.',
      'Which language should she speak?',
      'What language would you like her to speak?',
    ],
  },

  ASK_SKILLS: {
    label: 'Asking which skills are required',
    hasOptions: true,
    strict: 'Choose required skills.',
    flexible: [
      'Choose required skills.',
      'Which skills do you need her to have?',
      'What should she be able to help with?',
    ],
  },

  ASK_SAVE_ADDRESS: {
    label: 'Asking whether to save an address',
    hasOptions: true,
    strict: 'Do you want to save this address for later use?',
    flexible: [
      'Do you want to save this address for later use?',
      'Shall we save this address for next time?',
      'Would you like to keep this address on file?',
    ],
  },

  ASK_LIVE_IN: {
    label: 'Asking whether the nanny stays overnight',
    hasOptions: true,
    strict: '🏠 Will the nanny stay at your home during the booking?',
    flexible: [
      '🏠 Will the nanny stay at your home during the booking?',
      '🏠 Will she be staying at your home overnight?',
      '🏠 Does she need to stay at your place for this booking?',
    ],
  },

  /* ---------------------------------------------------------------- *
   * Never varied. Listed so the dashboard can show them and say why.
   * ---------------------------------------------------------------- */

  ASK_OTP: {
    label: 'Asking for the verification code',
    strict: "📲 We've sent you a verification code.\nEnter the 6-digit code.",
    flexible: null,
    fixedBecause: 'A verification step should read the same every time, so a phishing message is easier to spot.',
  },

  ASK_ID_FRONT: {
    label: 'Asking for the front of an ID card',
    strict: 'Add front image of your id card\nThis is a one time thing for security reasons',
    flexible: null,
    fixedBecause: 'An identity check is a formal request. Casual wording makes it sound optional.',
  },

  ASK_ID_BACK: {
    label: 'Asking for the back of an ID card',
    strict: 'Add back image of your id card\nThis is a one-time thing for security reasons',
    flexible: null,
    fixedBecause: 'An identity check is a formal request. Casual wording makes it sound optional.',
  },

  ASK_PAYMENT_PROOF: {
    label: 'Asking for proof of a transfer',
    strict: '📸 Please send a *screenshot* of your transfer receipt.\n\nAttach it as an image in this chat.',
    flexible: null,
    fixedBecause: 'This is about money. Exactly what is being asked for has to be unambiguous.',
  },

  ASK_CHILD_MEDICAL: {
    label: 'Asking about allergies and medical needs',
    placeholders: ['{{name}}'],
    strict: 'Does {{name}} have any allergies, medical conditions, or special care needs? Please tell us about them.',
    flexible: null,
    fixedBecause: 'A wording that sounds casual invites a casual answer, and this is the answer a nanny may one day need in an emergency.',
  },

  CONFIRM_BOOKING_DETAILS: {
    label: 'Reading the booking back before confirming',
    strict: null,
    flexible: null,
    fixedBecause: 'This is the summary somebody agrees to. It is assembled from the booking itself, not phrased.',
  },
};

/** Every question, in the order the dashboard should list them. */
export const PHRASE_KEYS = Object.keys(PHRASES);

/**
 * Which wording to use for one question, right now.
 *
 * `overrides` holds anything edited in the dashboard, so a change there wins
 * over what is written above without needing a deploy.
 */
export function pickPhrase(key, mode, overrides = {}) {
  const entry = PHRASES[key];
  if (!entry) return null;

  const edited = overrides[key];
  const strict = edited?.strict ?? entry.strict;

  if (mode !== PHRASING.FLEXIBLE || ALWAYS_STRICT.has(key)) return strict;

  const pool = edited?.flexible ?? entry.flexible;
  if (!Array.isArray(pool) || !pool.length) return strict;

  // Random per message rather than round-robin: a cycle is itself a pattern,
  // and two families comparing notes should not see the same sequence.
  return pool[Math.floor(Math.random() * pool.length)];
}


/**
 * Swap a message for an alternative wording of the same question.
 *
 * Matched on the text itself rather than by key, because the flows reference
 * `M.ASK_*` in dozens of places and threading a key through all of them would
 * be a large change for a cosmetic feature. The cost is that a question is
 * only recognised when its strict wording is intact, which is also the safe
 * failure: unrecognised text is passed through untouched.
 *
 * The lookup is built once, on first use, from whatever the strict wordings
 * are at that moment — including any edited in the dashboard.
 */
let lookup = null;
let lookupFor = null;

function buildLookup(overrides) {
  const map = new Map();
  for (const key of PHRASE_KEYS) {
    if (ALWAYS_STRICT.has(key)) continue;
    const strict = overrides[key]?.strict ?? PHRASES[key].strict;
    if (typeof strict === 'string' && strict.trim()) map.set(strict.trim(), key);
  }
  return map;
}

/**
 * Reword one outbound message, if it is a question we hold alternatives for.
 *
 * Returns the text unchanged when phrasing is strict, when the message is
 * not a question in the phrasebook, or on any error — this sits on the path
 * of a reply somebody is waiting for, and must never be the reason one fails
 * to arrive.
 */
export async function reword(text) {
  const original = String(text ?? '');
  if (!original.trim()) return original;

  try {
    const mode = await getPhrasingMode();
    if (mode !== PHRASING.FLEXIBLE) return original;

    const overrides = await getOverrides();

    // Rebuilt when the overrides change, so an edit takes effect without a
    // restart. The stamp is cheap next to the lookup it guards.
    const stamp = JSON.stringify(overrides);
    if (lookup === null || lookupFor !== stamp) {
      lookup = buildLookup(overrides);
      lookupFor = stamp;
    }

    // A menu question carries its options after the first line, so the
    // opening sentence is matched on its own and the options are kept.
    const [firstLine, ...rest] = original.split('\n');

    const wholeKey = lookup.get(original.trim());
    if (wholeKey) return pickPhrase(wholeKey, mode, overrides);

    const lineKey = lookup.get(firstLine.trim());
    if (lineKey && PHRASES[lineKey].hasOptions) {
      const swapped = pickPhrase(lineKey, mode, overrides);
      return [swapped, ...rest].join('\n');
    }

    return original;
  } catch {
    return original;
  }
}

/** The phrasing mode in force, defaulting to strict. */
export async function getPhrasingMode() {
  try {
    const row = await Setting.findOne({ key: 'phrasing' }).lean();
    const mode = row?.value?.mode;
    return mode === PHRASING.FLEXIBLE ? PHRASING.FLEXIBLE : PHRASING.STRICT;
  } catch {
    // A settings lookup that fails must not stop the bot answering.
    return PHRASING.STRICT;
  }
}

/** Wording edited in the dashboard, keyed by question. */
export async function getOverrides() {
  try {
    const row = await Setting.findOne({ key: 'phrasingOverrides' }).lean();
    return row?.value && typeof row.value === 'object' ? row.value : {};
  } catch {
    return {};
  }
}

export default {
  PHRASING, PHRASES, PHRASE_KEYS, ALWAYS_STRICT,
  pickPhrase, reword, getPhrasingMode, getOverrides,
};
