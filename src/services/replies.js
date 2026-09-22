import { Setting } from '../models/index.js';

/**
 * What the bot replies when somebody asks something instead of answering.
 *
 * The structured flow asks a fixed question at every step and expects a
 * particular kind of answer back. Real people do not behave that way. Asked
 * "how long do you need the nanny?", a family will reply "what's the minimum?"
 * — a fair question, and one the flow has no answer to, so it repeats itself
 * and the family repeats themselves.
 *
 * This is the answer sheet for those moments. Every step of the flow has a
 * box; whatever is written in it is what the bot knows at that point. Nothing
 * is invented and nothing is generated — an empty box means the bot carries
 * on exactly as it does now, repeating the question.
 *
 * Two modes, and they differ only in how literally the written answer is
 * used:
 *
 *   strict    — reply with exactly what is in the box, word for word.
 *   flexible  — the same facts, worded to fit what was actually asked.
 *
 * The whole feature is off until somebody turns it on. An answer sheet that
 * nobody has filled in should not start changing what the bot says.
 */

export const REPLY_MODE = { STRICT: 'strict', FLEXIBLE: 'flexible' };

/**
 * Every step of the structured flow, in the order a family meets them.
 *
 * `question` is the wording as the bot asks it today, shown so whoever fills
 * in the answer box can see what it is answering. It is never changed here —
 * the flow is structured, and the questions stay exactly as they are.
 *
 * `asks` are the things people actually say at that step instead of
 * answering, gathered so the box is filled in with the right thing in mind
 * rather than from a blank page.
 */
export const FLOW_STEPS = [
  /* ---------------- Getting started ---------------- */
  {
    key: 'ASK_FULL_NAME',
    group: 'Getting started',
    question: "Before we begin, let's create your account.\nWhat's your full name?",
    asks: ['Why do you need my name?', 'Is this free?', 'Who are you?'],
  },
  {
    key: 'ASK_EMAIL',
    group: 'Getting started',
    question: "Great {{name}}.\nWhat's your email?",
    asks: ['Why do you need my email?', 'Will you spam me?', 'Can I skip this?'],
  },
  {
    key: 'ASK_OTP',
    group: 'Getting started',
    question: "📲 We've sent you a verification code.\nEnter the 6-digit code.",
    asks: ["I didn't get the code", 'Can you resend it?', 'How long is it valid?'],
  },

  /* ---------------- Where and when ---------------- */
  {
    key: 'ASK_LOCATION',
    group: 'Where and when',
    question: 'Where do you need childcare?\n📍 Share your google map location',
    asks: ['Which areas do you cover?', 'Do you come to hotels?', 'Do you cover Ubud?'],
  },
  {
    key: 'ASK_ADDRESS',
    group: 'Where and when',
    question: 'Type your exact address.',
    asks: ['Why do you need the exact address?', 'Is my address kept private?'],
  },
  {
    key: 'ASK_FREQUENCY',
    group: 'Where and when',
    question: 'How often do you need a nanny?',
    asks: ['What are the options?', 'Can I change it later?', 'Is one day possible?'],
  },
  {
    key: 'ASK_START_DATE',
    group: 'Where and when',
    question: 'When would you like the booking to start?',
    asks: ['How far ahead can I book?', 'Can I book for today?', 'How much notice do you need?'],
  },
  {
    key: 'ASK_START_TIME',
    group: 'Where and when',
    question: 'What time does the session start?',
    asks: ['How early can she start?', 'Do you do nights?', 'Is there a late fee?'],
  },
  {
    key: 'ASK_DURATION',
    group: 'Where and when',
    question: 'How long do you need the nanny?',
    asks: ['What is the minimum?', 'Can she stay longer?', 'What about overtime?'],
  },
  {
    key: 'ASK_REPEAT_DAYS',
    group: 'Where and when',
    question: 'Which days should the booking repeat on?',
    asks: ['Can I change days later?', 'What if we skip a week?'],
  },
  {
    key: 'ASK_LIVE_IN',
    group: 'Where and when',
    question: '🏠 Will the nanny stay at your home during the booking?',
    asks: ['What does live-in cost?', 'Does she need her own room?', "What if we don't have space?"],
  },

  /* ---------------- The children ---------------- */
  {
    key: 'ASK_CHILD_COUNT',
    group: 'The children',
    question: 'How many children need care?',
    asks: ['Is it more expensive for two?', 'Can one nanny take three?'],
  },
  {
    key: 'ASK_CHILD_AGE',
    group: 'The children',
    question: 'How old is {{name}}?',
    asks: ['Do you take newborns?', 'Is there an age limit?', 'Do you do babies?'],
  },
  {
    key: 'ASK_CHILD_MEDICAL',
    group: 'The children',
    question: 'Does {{name}} have any allergies, medical conditions, or special care needs?',
    asks: ['Are your nannies trained for allergies?', 'Do they know CPR?', 'Who sees this information?'],
  },
  {
    key: 'ASK_CHILD_DIET',
    group: 'The children',
    question: 'Does {{name}} have any dietary requirements or foods to avoid?',
    asks: ['Can she cook?', 'Do we provide the food?'],
  },

  /* ---------------- What you need ---------------- */
  {
    key: 'ASK_LANGUAGES',
    group: 'What you need',
    question: 'Choose a language.',
    asks: ['Do you have English speakers?', 'Are they fluent?'],
  },
  {
    key: 'ASK_SKILLS',
    group: 'What you need',
    question: 'Choose required skills.',
    asks: ['What does newborn care include?', 'Do they clean?', 'Will she cook?'],
  },
  {
    key: 'ASK_OTHER_INSTRUCTIONS',
    group: 'What you need',
    question: 'Is there anything else the nanny should know about your family or children?',
    asks: ['Can I add this later?', 'Does she get told all of this?'],
  },

  /* ---------------- Money ---------------- */
  {
    key: 'CONFIRM_BOOKING_DETAILS',
    group: 'Money',
    question: 'The booking summary, read back before confirming.',
    asks: ['Why is it this much?', 'Can I get a discount?', 'What is the transport fee?'],
  },
  {
    key: 'ASK_PAYMENT_PROOF',
    group: 'Money',
    question: '📸 Please send a *screenshot* of your transfer receipt.',
    asks: ['Which bank?', 'Can I pay cash?', 'When is it confirmed?', 'Can I pay on the day?'],
  },

  /* ---------------- Identity ---------------- */
  {
    key: 'ASK_ID_FRONT',
    group: 'Identity',
    question: 'Add front image of your id card.',
    asks: ['Why do you need my ID?', 'Is it safe?', 'Can I skip this?'],
  },
];

export const STEP_KEYS = FLOW_STEPS.map((s) => s.key);


/**
 * Which step of the sheet a conversation state belongs to.
 *
 * The flow names its states after where it is ("FF_DURATION"), while the
 * sheet is keyed by the question ("ASK_DURATION"), and several states ask the
 * same question — editing a booking asks about duration too, and a family
 * deserves the same answer whichever way they arrived at it.
 *
 * Built from the flows as they stand. A state not listed simply has no
 * answer, which is the same as an empty box.
 */
const STATE_TO_STEP = {
  FP_SET_EMAIL: 'ASK_EMAIL',
  FP_VERIFY_EMAIL: 'ASK_EMAIL',

  FF_LOCATION: 'ASK_LOCATION',
  FF_EDIT_LOCATION: 'ASK_LOCATION',
  FF_EMERGENCY_LOCATION: 'ASK_LOCATION',

  FF_ADDRESS: 'ASK_ADDRESS',
  FF_SAVE_ADDRESS: 'ASK_ADDRESS',
  FF_PICK_SAVED_ADDRESS: 'ASK_ADDRESS',

  FF_FREQUENCY: 'ASK_FREQUENCY',
  FF_START_DATE: 'ASK_START_DATE',

  FF_START_TIME: 'ASK_START_TIME',
  FF_EDIT_START_TIME: 'ASK_START_TIME',

  FF_DURATION: 'ASK_DURATION',
  FF_EDIT_DURATION: 'ASK_DURATION',
  FB_RESCHEDULE_DURATION: 'ASK_DURATION',

  FF_REPEAT_DAYS: 'ASK_REPEAT_DAYS',
  FF_EDIT_REPEAT_DAYS: 'ASK_REPEAT_DAYS',

  FF_LIVE_IN: 'ASK_LIVE_IN',
  FF_CHILD_COUNT: 'ASK_CHILD_COUNT',

  FF_CHILD_AGE: 'ASK_CHILD_AGE',
  FP_CHILD_AGE: 'ASK_CHILD_AGE',

  FF_CHILD_MEDICAL: 'ASK_CHILD_MEDICAL',
  FP_CHILD_MEDICAL: 'ASK_CHILD_MEDICAL',

  FF_CHILD_DIET: 'ASK_CHILD_DIET',
  FP_CHILD_DIET: 'ASK_CHILD_DIET',

  FF_LANGUAGES: 'ASK_LANGUAGES',
  FF_EDIT_LANGUAGES: 'ASK_LANGUAGES',
  FB_CHANGE_LANGUAGES: 'ASK_LANGUAGES',

  FF_SKILLS: 'ASK_SKILLS',
  FF_EDIT_SKILLS: 'ASK_SKILLS',
  FB_CHANGE_SKILLS: 'ASK_SKILLS',

  FF_OTHER_INSTRUCTIONS: 'ASK_OTHER_INSTRUCTIONS',
  FF_ID_FRONT: 'ASK_ID_FRONT',
  NR_ID_FRONT: 'ASK_ID_FRONT',
};

/** The step this state is asking about, if the sheet covers it. */
export function stepForState(state) {
  return STATE_TO_STEP[String(state || '')] || null;
}

/** Everything off, and nothing written, until somebody says otherwise. */
const OFF = { enabled: false, mode: REPLY_MODE.STRICT, answers: {} };

/**
 * The answer sheet as it stands.
 *
 * Read on the path of a live conversation, so a failure returns "off" rather
 * than throwing: the bot carrying on as it always has is a safe outcome, and
 * an exception here would cost somebody their reply.
 */
export async function getReplySheet() {
  try {
    const row = await Setting.findOne({ key: 'replySheet' }).lean();
    const v = row?.value;
    if (!v || typeof v !== 'object') return OFF;

    return {
      enabled: Boolean(v.enabled),
      mode: v.mode === REPLY_MODE.FLEXIBLE ? REPLY_MODE.FLEXIBLE : REPLY_MODE.STRICT,
      answers: v.answers && typeof v.answers === 'object' ? v.answers : {},
    };
  } catch {
    return OFF;
  }
}

/**
 * The written answer for one step, or null when there is nothing to say.
 *
 * Null is the important case and the common one: it means the box is empty,
 * or the sheet is switched off, and the bot should behave exactly as it does
 * without this feature rather than improvising.
 */
export function answerFor(stepKey, sheet) {
  if (!sheet?.enabled) return null;
  const text = String(sheet.answers?.[stepKey] || '').trim();
  return text || null;
}

export default { REPLY_MODE, FLOW_STEPS, STEP_KEYS, getReplySheet, answerFor, stepForState };
