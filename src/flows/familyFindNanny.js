import { on } from './engine.js';
import { makeNameHandler, makeEmailHandler, makeOtpHandler } from './common.js';
import { User, Booking, ChatThread } from '../models/index.js';
import {
  USER_ROLE, LANGUAGES, SKILLS, SUBJECTS, DURATION_OPTIONS, CPR_REQUIREMENT,
} from '../utils/constants.js';
import {
  parseChoice, parseMultiChoice, pickFrom, parseYesNo, parseMoney, parseTime,
  parseDate, parseWeekdays, parseMapUrl, parseInteger, clean, isNone, lower,
} from '../utils/parse.js';
import { findNannies } from '../services/matching.js';
import { buildServiceDays } from '../services/booking.js';
import { computeBookingAmount } from '../services/policy.js';
import * as M from '../utils/messages.js';

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];

/* ------------------------------------------------------------------ *
 * Registration (family)
 * ------------------------------------------------------------------ */

on('FAMILY_REG_NAME', makeNameHandler('FAMILY_REG_EMAIL'));
on('FAMILY_REG_EMAIL', makeEmailHandler('FAMILY_REG_OTP'));
on('FAMILY_REG_OTP', makeOtpHandler({
  role: USER_ROLE.FAMILY,
  onVerified: async (ctx, user) => {
    user.registrationComplete = true;
    await user.save();
    const firstName = (user.fullName || '').split(' ')[0];
    // Registration is entered from "Find a Nanny", so continue into that flow.
    return [
      { text: M.ACCOUNT_VERIFIED(firstName) },
      { text: `${M.FIND_NANNY_INTRO}\n\n${M.ASK_LOCATION}`, state: 'FF_LOCATION', user: user._id },
    ];
  },
}));

on('FAMILY_REG_RESUME', async (ctx) => ({
  text: M.ASK_FULL_NAME,
  state: 'FAMILY_REG_NAME',
}));

/* ------------------------------------------------------------------ *
 * Find a nanny — location & address
 * ------------------------------------------------------------------ */

export async function startFindNanny(ctx) {
  const user = ctx.user || (await User.findById(ctx.session.user));

  // Offer saved addresses when the family has any.
  if (user?.addresses?.length) {
    const list = user.addresses
      .map((a, i) => `${i + 1}. ${a.label || 'Address'} — ${a.addressLine || ''}`)
      .join('\n');
    return {
      text: `${M.FIND_NANNY_INTRO}\n\nWhere do you need childcare?\n\n${list}\n${user.addresses.length + 1}. Use a new address`,
      state: 'FF_PICK_SAVED_ADDRESS',
      resetData: true,
    };
  }
  return { text: `${M.FIND_NANNY_INTRO}\n\n${M.ASK_LOCATION}`, state: 'FF_LOCATION', resetData: true };
}

const pickSavedAddress = async (ctx) => {
  const user = ctx.user || (await User.findById(ctx.session.user));
  const count = user?.addresses?.length || 0;
  const choice = parseChoice(ctx.text, count + 1);
  if (!choice) return M.INVALID_CHOICE;

  if (choice === count + 1) {
    return { text: M.ASK_LOCATION, state: 'FF_LOCATION' };
  }
  const addr = user.addresses[choice - 1];
  ctx.set('address', {
    label: addr.label, mapUrl: addr.mapUrl, addressLine: addr.addressLine,
  });
  return { text: M.ASK_FREQUENCY, state: 'FF_FREQUENCY' };
};
pickSavedAddress.prompt = async (ctx) => {
  const user = ctx.user || (await User.findById(ctx.session.user));
  const list = (user?.addresses || [])
    .map((a, i) => `${i + 1}. ${a.label || 'Address'} — ${a.addressLine || ''}`).join('\n');
  return `Where do you need childcare?\n\n${list}\n${(user?.addresses?.length || 0) + 1}. Use a new address`;
};
on('FF_PICK_SAVED_ADDRESS', pickSavedAddress);

const locationHandler = async (ctx) => {
  const parsed = parseMapUrl(ctx.text);
  if (!parsed) {
    return `❌ Please share a Google Maps link, or type *None* if it's not available.`;
  }
  ctx.set('mapUrl', parsed.url);
  return { text: M.ASK_ADDRESS, state: 'FF_ADDRESS' };
};
locationHandler.prompt = () => M.ASK_LOCATION;
on('FF_LOCATION', locationHandler);

const addressHandler = async (ctx) => {
  const line = clean(ctx.text);
  if (line.length < 3) return 'Please type your exact address.';
  ctx.set('addressLine', line);
  return { text: M.ASK_SAVE_ADDRESS, state: 'FF_SAVE_ADDRESS' };
};
addressHandler.prompt = () => M.ASK_ADDRESS;
on('FF_ADDRESS', addressHandler);

const saveAddressHandler = async (ctx) => {
  const yes = parseYesNo(ctx.text);
  if (yes === null) return M.ASK_SAVE_ADDRESS;

  if (!yes) {
    ctx.set('address', {
      mapUrl: ctx.get('mapUrl'), addressLine: ctx.get('addressLine'),
    });
    return { text: M.ASK_FREQUENCY, state: 'FF_FREQUENCY' };
  }
  return { text: M.ASK_ADDRESS_LABEL, state: 'FF_ADDRESS_LABEL' };
};
saveAddressHandler.prompt = () => M.ASK_SAVE_ADDRESS;
on('FF_SAVE_ADDRESS', saveAddressHandler);

const addressLabelHandler = async (ctx) => {
  const raw = clean(ctx.text);
  if (!raw) return M.ASK_ADDRESS_LABEL;

  const user = ctx.user || (await User.findById(ctx.session.user));
  // Spec: if the title is already used, auto-suffix (Home 1, Home 2...).
  const label = uniqueLabel(raw, (user?.addresses || []).map((a) => a.label));

  const address = { label, mapUrl: ctx.get('mapUrl'), addressLine: ctx.get('addressLine') };
  if (user) {
    user.addresses.push({ ...address, isDefault: user.addresses.length === 0 });
    await user.save();
  }
  ctx.set('address', address);
  return [
    { text: M.ADDRESS_SAVED },
    { text: M.ASK_FREQUENCY, state: 'FF_FREQUENCY' },
  ];
};
addressLabelHandler.prompt = () => M.ASK_ADDRESS_LABEL;
on('FF_ADDRESS_LABEL', addressLabelHandler);

export function uniqueLabel(desired, existing = []) {
  const taken = new Set(existing.filter(Boolean).map((s) => s.toLowerCase()));
  if (!taken.has(desired.toLowerCase())) return desired;
  let i = 1;
  while (taken.has(`${desired} ${i}`.toLowerCase())) i += 1;
  return `${desired} ${i}`;
}

/* ------------------------------------------------------------------ *
 * Schedule
 * ------------------------------------------------------------------ */

const frequencyHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, 2);
  if (!choice) return M.ASK_FREQUENCY;
  ctx.set('isMultiDay', choice === 2);
  return { text: M.ASK_START_DATE, state: 'FF_START_DATE' };
};
frequencyHandler.prompt = () => M.ASK_FREQUENCY;
on('FF_FREQUENCY', frequencyHandler);

const startDateHandler = async (ctx) => {
  const date = parseDate(ctx.text);
  if (!date) return `❌ I couldn't read that date. Try a format like *12 August* or *2026-08-12*.`;
  if (new Date(`${date}T23:59:59`) < new Date()) {
    return '❌ That date is in the past. Please choose a future date.';
  }
  ctx.set('startDate', date);

  if (ctx.get('isMultiDay')) {
    return { text: M.ASK_END_DATE, state: 'FF_END_DATE' };
  }
  return [
    { text: M.IMPORTANT_FAMILY_INFO },
    { text: M.ASK_START_TIME, state: 'FF_START_TIME' },
  ];
};
startDateHandler.prompt = () => M.ASK_START_DATE;
on('FF_START_DATE', startDateHandler);

const endDateHandler = async (ctx) => {
  const date = parseDate(ctx.text);
  if (!date) return `❌ I couldn't read that date. Try a format like *30 August* or *2026-08-30*.`;
  if (date < ctx.get('startDate')) {
    return '❌ The end date must be on or after the start date.';
  }
  ctx.set('endDate', date);
  return { text: M.ASK_REPEAT_DAYS, state: 'FF_REPEAT_DAYS' };
};
endDateHandler.prompt = () => M.ASK_END_DATE;
on('FF_END_DATE', endDateHandler);

const repeatDaysHandler = async (ctx) => {
  const days = parseWeekdays(ctx.text);
  if (!days) return M.ASK_REPEAT_DAYS;
  ctx.set('repeatDays', days);

  // Guard against a range whose repeat days never occur.
  const preview = buildServiceDays({
    startDate: ctx.get('startDate'), endDate: ctx.get('endDate'),
    startTime: '09:00', hoursPerDay: 1, repeatDays: days, hourlyRate: 0,
  });
  if (!preview.length) {
    return `❌ None of those days fall between ${ctx.get('startDate')} and ${ctx.get('endDate')}.\n\n${M.ASK_REPEAT_DAYS}`;
  }

  return [
    { text: M.IMPORTANT_FAMILY_INFO },
    { text: M.ASK_START_TIME, state: 'FF_START_TIME' },
  ];
};
repeatDaysHandler.prompt = () => M.ASK_REPEAT_DAYS;
on('FF_REPEAT_DAYS', repeatDaysHandler);

const startTimeHandler = async (ctx) => {
  const time = parseTime(ctx.text);
  if (!time) return `❌ I couldn't read that time. Try *9 AM* or *09:00*.`;
  ctx.set('startTime', time);
  return { text: M.ASK_DURATION, state: 'FF_DURATION' };
};
startTimeHandler.prompt = () => M.ASK_START_TIME;
on('FF_START_TIME', startTimeHandler);

const durationHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, DURATION_OPTIONS.length);
  if (!choice) return M.ASK_DURATION;
  ctx.set('hoursPerDay', DURATION_OPTIONS[choice - 1]);
  return { text: M.ASK_LANGUAGES, state: 'FF_LANGUAGES' };
};
durationHandler.prompt = () => M.ASK_DURATION;
on('FF_DURATION', durationHandler);

/* ------------------------------------------------------------------ *
 * Requirements
 * ------------------------------------------------------------------ */

const languagesHandler = async (ctx) => {
  const idx = parseMultiChoice(ctx.text, LANGUAGES.length);
  if (!idx) return M.ASK_LANGUAGES;
  ctx.set('languages', pickFrom(LANGUAGES, idx));
  return { text: M.ASK_SKILLS, state: 'FF_SKILLS' };
};
languagesHandler.prompt = () => M.ASK_LANGUAGES;
on('FF_LANGUAGES', languagesHandler);

const skillsHandler = async (ctx) => {
  const idx = parseMultiChoice(ctx.text, SKILLS.length);
  if (!idx) return M.ASK_SKILLS;
  const skills = pickFrom(SKILLS, idx);
  ctx.set('skills', skills);

  // Subjects are only asked when tutoring is requested.
  if (skills.includes('Tutoring')) {
    return { text: M.ASK_SUBJECTS, state: 'FF_SUBJECTS' };
  }
  ctx.set('subjects', []);
  return { text: M.ASK_BUDGET_MIN, state: 'FF_BUDGET_MIN' };
};
skillsHandler.prompt = () => M.ASK_SKILLS;
on('FF_SKILLS', skillsHandler);

const subjectsHandler = async (ctx) => {
  const idx = parseMultiChoice(ctx.text, SUBJECTS.length);
  if (!idx) return M.ASK_SUBJECTS;
  ctx.set('subjects', pickFrom(SUBJECTS, idx));
  return { text: M.ASK_BUDGET_MIN, state: 'FF_BUDGET_MIN' };
};
subjectsHandler.prompt = () => M.ASK_SUBJECTS;
on('FF_SUBJECTS', subjectsHandler);

const budgetMinHandler = async (ctx) => {
  const v = parseMoney(ctx.text);
  if (v === null) return `❌ Please enter an amount, for example *$25*.`;
  ctx.set('budgetMin', v);
  return { text: M.ASK_BUDGET_MAX, state: 'FF_BUDGET_MAX' };
};
budgetMinHandler.prompt = () => M.ASK_BUDGET_MIN;
on('FF_BUDGET_MIN', budgetMinHandler);

const budgetMaxHandler = async (ctx) => {
  const v = parseMoney(ctx.text);
  if (v === null) return `❌ Please enter an amount, for example *$45*.`;
  if (v < ctx.get('budgetMin')) {
    return `❌ Your maximum budget must be at least your minimum (${ctx.get('budgetMin')}).`;
  }
  ctx.set('budgetMax', v);
  return { text: M.ASK_CPR, state: 'FF_CPR' };
};
budgetMaxHandler.prompt = () => M.ASK_BUDGET_MAX;
on('FF_BUDGET_MAX', budgetMaxHandler);

const cprHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, 3);
  if (!choice) return M.ASK_CPR;
  ctx.set('cpr', [CPR_REQUIREMENT.REQUIRED, CPR_REQUIREMENT.NOT_REQUIRED, CPR_REQUIREMENT.EITHER][choice - 1]);
  return { text: M.ASK_CHILD_COUNT, state: 'FF_CHILD_COUNT' };
};
cprHandler.prompt = () => M.ASK_CPR;
on('FF_CPR', cprHandler);

/* ------------------------------------------------------------------ *
 * Children
 * ------------------------------------------------------------------ */

const childCountHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, 4);
  if (!choice) return M.ASK_CHILD_COUNT;

  // Option 4 is "Four or more" — ask for the exact number.
  if (choice === 4) {
    return { text: M.ASK_CHILD_COUNT_EXACT, state: 'FF_CHILD_COUNT_EXACT' };
  }
  ctx.merge({ childCount: choice, children: [], childIndex: 0 });
  return [
    { text: M.CHILD_INTRO },
    { text: M.ASK_CHILD_NAME(ORDINALS[0]), state: 'FF_CHILD_NAME' },
  ];
};
childCountHandler.prompt = () => M.ASK_CHILD_COUNT;
on('FF_CHILD_COUNT', childCountHandler);

const childCountExactHandler = async (ctx) => {
  const n = parseInteger(ctx.text, { min: 4, max: 12 });
  if (!n) return `❌ Please type a number between 4 and 12.`;
  ctx.merge({ childCount: n, children: [], childIndex: 0 });
  return [
    { text: M.CHILD_INTRO },
    { text: M.ASK_CHILD_NAME(ORDINALS[0]), state: 'FF_CHILD_NAME' },
  ];
};
childCountExactHandler.prompt = () => M.ASK_CHILD_COUNT_EXACT;
on('FF_CHILD_COUNT_EXACT', childCountExactHandler);

const childNameHandler = async (ctx) => {
  const name = clean(ctx.text);
  if (name.length < 1) return M.ASK_CHILD_NAME(ORDINALS[ctx.get('childIndex', 0)] || 'next');
  ctx.set('currentChild', { name });
  return { text: M.ASK_CHILD_AGE(name), state: 'FF_CHILD_AGE' };
};
childNameHandler.prompt = (ctx) => M.ASK_CHILD_NAME(ORDINALS[ctx.get('childIndex', 0)] || 'next');
on('FF_CHILD_NAME', childNameHandler);

const childAgeHandler = async (ctx) => {
  const age = clean(ctx.text);
  if (!age) return M.ASK_CHILD_AGE(ctx.get('currentChild')?.name || 'the child');
  const child = { ...ctx.get('currentChild'), age };
  ctx.set('currentChild', child);
  return { text: M.ASK_CHILD_MEDICAL(child.name), state: 'FF_CHILD_MEDICAL' };
};
childAgeHandler.prompt = (ctx) => M.ASK_CHILD_AGE(ctx.get('currentChild')?.name || 'the child');
on('FF_CHILD_AGE', childAgeHandler);

const childMedicalHandler = async (ctx) => {
  const raw = clean(ctx.text);
  if (!raw) return M.ASK_CHILD_MEDICAL(ctx.get('currentChild')?.name || 'the child');
  const child = { ...ctx.get('currentChild'), medicalNotes: isNone(raw) ? '' : raw };
  ctx.set('currentChild', child);
  return { text: M.ASK_CHILD_DIET(child.name), state: 'FF_CHILD_DIET' };
};
childMedicalHandler.prompt = (ctx) => M.ASK_CHILD_MEDICAL(ctx.get('currentChild')?.name || 'the child');

const childDietHandler = async (ctx) => {
  const raw = clean(ctx.text);
  if (!raw) return M.ASK_CHILD_DIET(ctx.get('currentChild')?.name || 'the child');

  const child = { ...ctx.get('currentChild'), dietaryNotes: isNone(raw) ? '' : raw };
  const children = [...(ctx.get('children') || []), child];
  const nextIndex = ctx.get('childIndex', 0) + 1;
  ctx.merge({ children, childIndex: nextIndex, currentChild: null });

  const total = ctx.get('childCount', 1);

  // All children captured -> move on to free-text instructions.
  if (nextIndex >= total) {
    return [
      { text: M.CHILD_THANKS(child.name) },
      { text: M.ASK_OTHER_INSTRUCTIONS, state: 'FF_OTHER_INSTRUCTIONS' },
    ];
  }

  // After the first child the family may hand the rest to an agent.
  if (nextIndex === 1) {
    return [
      { text: M.CHILD_THANKS(child.name) },
      { text: M.ASK_CONTINUE_OR_AGENT, state: 'FF_CONTINUE_OR_AGENT' },
    ];
  }

  return [
    { text: M.CHILD_THANKS(child.name) },
    { text: M.ASK_CHILD_NAME(ORDINALS[nextIndex] || 'next'), state: 'FF_CHILD_NAME' },
  ];
};
childDietHandler.prompt = (ctx) => M.ASK_CHILD_DIET(ctx.get('currentChild')?.name || 'the child');
on('FF_CHILD_MEDICAL', childMedicalHandler);
on('FF_CHILD_DIET', childDietHandler);

const continueOrAgentHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, 2);
  if (!choice) return M.ASK_CONTINUE_OR_AGENT;

  if (choice === 2) {
    ctx.set('agentCallRequested', true);
    return [
      { text: M.AGENT_WILL_CALL },
      { text: M.ASK_OTHER_INSTRUCTIONS, state: 'FF_OTHER_INSTRUCTIONS' },
    ];
  }
  const idx = ctx.get('childIndex', 1);
  return { text: M.ASK_CHILD_NAME(ORDINALS[idx] || 'next'), state: 'FF_CHILD_NAME' };
};
continueOrAgentHandler.prompt = () => M.ASK_CONTINUE_OR_AGENT;
on('FF_CONTINUE_OR_AGENT', continueOrAgentHandler);

const otherInstructionsHandler = async (ctx) => {
  const raw = clean(ctx.text);
  if (!raw) return M.ASK_OTHER_INSTRUCTIONS;
  ctx.set('otherInstructions', isNone(raw) ? '' : raw);
  return showSummary(ctx);
};
otherInstructionsHandler.prompt = () => M.ASK_OTHER_INSTRUCTIONS;
on('FF_OTHER_INSTRUCTIONS', otherInstructionsHandler);

/* ------------------------------------------------------------------ *
 * Summary + edit
 * ------------------------------------------------------------------ */

/** Build a booking-shaped preview object from the session draft. */
export function draftToBooking(ctx, { hourlyRate = null } = {}) {
  const d = ctx.session.data || {};
  const rate = hourlyRate ?? d.hourlyRate ?? d.budgetMin ?? 0;
  const serviceDays = buildServiceDays({
    startDate: d.startDate,
    endDate: d.isMultiDay ? d.endDate : d.startDate,
    startTime: d.startTime,
    hoursPerDay: d.hoursPerDay,
    repeatDays: d.isMultiDay ? d.repeatDays : [],
    hourlyRate: rate,
  });
  return {
    isMultiDay: !!d.isMultiDay,
    startDate: d.startDate,
    endDate: d.isMultiDay ? d.endDate : d.startDate,
    startTime: d.startTime,
    hoursPerDay: d.hoursPerDay,
    repeatDays: d.isMultiDay ? d.repeatDays || [] : [],
    serviceDays,
    address: d.address || { mapUrl: d.mapUrl, addressLine: d.addressLine },
    requirements: {
      languages: d.languages || [], skills: d.skills || [], subjects: d.subjects || [],
      budgetMin: d.budgetMin, budgetMax: d.budgetMax, cpr: d.cpr,
    },
    children: d.children || [],
    otherInstructions: d.otherInstructions,
    agentCallRequested: !!d.agentCallRequested,
    hourlyRate: rate,
    totalAmount: computeBookingAmount({ hourlyRate: rate, hoursPerDay: d.hoursPerDay, days: serviceDays.length }),
  };
}

export async function showSummary(ctx, { updated = false } = {}) {
  const preview = draftToBooking(ctx);
  const title = updated ? '*Updated Booking Summary*' : '*Booking Summary*';
  return [
    { text: M.bookingSummary(preview, { title }) },
    { text: M.CONFIRM_BOOKING_DETAILS, state: 'FF_CONFIRM_SUMMARY' },
  ];
}

const confirmSummaryHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, 2);
  if (!choice) {
    if (lower(ctx.text) === 'edit') return { text: M.EDIT_MENU, state: 'FF_EDIT_MENU' };
    if (lower(ctx.text) === 'continue') return searchNannies(ctx);
    return M.CONFIRM_BOOKING_DETAILS;
  }
  if (choice === 2) return { text: M.EDIT_MENU, state: 'FF_EDIT_MENU' };
  return searchNannies(ctx);
};
confirmSummaryHandler.prompt = () => M.CONFIRM_BOOKING_DETAILS;
on('FF_CONFIRM_SUMMARY', confirmSummaryHandler);

const editMenuHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, 9);
  if (!choice) return M.EDIT_MENU;

  const routes = {
    1: { text: M.ASK_LOCATION, state: 'FF_EDIT_LOCATION' },
    2: { text: M.ASK_START_TIME, state: 'FF_EDIT_START_TIME' },
    3: { text: M.ASK_REPEAT_DAYS, state: 'FF_EDIT_REPEAT_DAYS' },
    4: { text: M.ASK_DURATION, state: 'FF_EDIT_DURATION' },
    5: { text: M.ASK_LANGUAGES, state: 'FF_EDIT_LANGUAGES' },
    6: { text: M.ASK_SKILLS, state: 'FF_EDIT_SKILLS' },
    7: { text: M.ASK_SUBJECTS, state: 'FF_EDIT_SUBJECTS' },
    8: { text: M.ASK_BUDGET_MIN, state: 'FF_EDIT_BUDGET_MIN' },
    9: { text: M.ASK_CHILD_COUNT, state: 'FF_EDIT_CHILDREN' },
  };

  // "Repeat on" only applies to multi-day bookings.
  if (choice === 3 && !ctx.get('isMultiDay')) {
    return `This is a single-day booking, so there are no repeat days.\n\n${M.EDIT_MENU}`;
  }
  return routes[choice];
};
editMenuHandler.prompt = () => M.EDIT_MENU;
on('FF_EDIT_MENU', editMenuHandler);

/** Each edit step writes its field then asks whether anything else changes. */
function editStep(state, apply, promptFn) {
  const handler = async (ctx) => {
    const result = await apply(ctx);
    if (typeof result === 'string') return result;   // validation error
    return { text: M.EDIT_ANYTHING_ELSE, state: 'FF_EDIT_MORE' };
  };
  handler.prompt = promptFn;
  on(state, handler);
}

editStep('FF_EDIT_LOCATION', async (ctx) => {
  const parsed = parseMapUrl(ctx.text);
  if (!parsed) return '❌ Please share a Google Maps link, or type *None*.';
  ctx.set('mapUrl', parsed.url);
  ctx.set('address', { ...(ctx.get('address') || {}), mapUrl: parsed.url });
  return true;
}, () => M.ASK_LOCATION);

editStep('FF_EDIT_START_TIME', async (ctx) => {
  const t = parseTime(ctx.text);
  if (!t) return '❌ Try *9 AM* or *09:00*.';
  ctx.set('startTime', t);
  return true;
}, () => M.ASK_START_TIME);

editStep('FF_EDIT_REPEAT_DAYS', async (ctx) => {
  const days = parseWeekdays(ctx.text);
  if (!days) return M.ASK_REPEAT_DAYS;
  ctx.set('repeatDays', days);
  return true;
}, () => M.ASK_REPEAT_DAYS);

editStep('FF_EDIT_DURATION', async (ctx) => {
  const c = parseChoice(ctx.text, DURATION_OPTIONS.length);
  if (!c) return M.ASK_DURATION;
  ctx.set('hoursPerDay', DURATION_OPTIONS[c - 1]);
  return true;
}, () => M.ASK_DURATION);

editStep('FF_EDIT_LANGUAGES', async (ctx) => {
  const idx = parseMultiChoice(ctx.text, LANGUAGES.length);
  if (!idx) return M.ASK_LANGUAGES;
  ctx.set('languages', pickFrom(LANGUAGES, idx));
  return true;
}, () => M.ASK_LANGUAGES);

editStep('FF_EDIT_SKILLS', async (ctx) => {
  const idx = parseMultiChoice(ctx.text, SKILLS.length);
  if (!idx) return M.ASK_SKILLS;
  const skills = pickFrom(SKILLS, idx);
  ctx.set('skills', skills);
  if (!skills.includes('Tutoring')) ctx.set('subjects', []);
  return true;
}, () => M.ASK_SKILLS);

editStep('FF_EDIT_SUBJECTS', async (ctx) => {
  const idx = parseMultiChoice(ctx.text, SUBJECTS.length);
  if (!idx) return M.ASK_SUBJECTS;
  ctx.set('subjects', pickFrom(SUBJECTS, idx));
  return true;
}, () => M.ASK_SUBJECTS);

const editBudgetMin = async (ctx) => {
  const v = parseMoney(ctx.text);
  if (v === null) return '❌ Please enter an amount, for example *$25*.';
  ctx.set('budgetMin', v);
  return { text: M.ASK_BUDGET_MAX, state: 'FF_EDIT_BUDGET_MAX' };
};
editBudgetMin.prompt = () => M.ASK_BUDGET_MIN;
on('FF_EDIT_BUDGET_MIN', editBudgetMin);

editStep('FF_EDIT_BUDGET_MAX', async (ctx) => {
  const v = parseMoney(ctx.text);
  if (v === null) return '❌ Please enter an amount, for example *$45*.';
  if (v < ctx.get('budgetMin')) return `❌ Maximum must be at least ${ctx.get('budgetMin')}.`;
  ctx.set('budgetMax', v);
  return true;
}, () => M.ASK_BUDGET_MAX);

/** Re-run the whole children sub-flow. */
const editChildrenHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, 4);
  if (!choice) return M.ASK_CHILD_COUNT;
  if (choice === 4) return { text: M.ASK_CHILD_COUNT_EXACT, state: 'FF_CHILD_COUNT_EXACT' };
  ctx.merge({ childCount: choice, children: [], childIndex: 0 });
  return [
    { text: M.CHILD_INTRO },
    { text: M.ASK_CHILD_NAME(ORDINALS[0]), state: 'FF_CHILD_NAME' },
  ];
};
editChildrenHandler.prompt = () => M.ASK_CHILD_COUNT;
on('FF_EDIT_CHILDREN', editChildrenHandler);

const editMoreHandler = async (ctx) => {
  const yes = parseYesNo(ctx.text);
  if (yes === null) return M.EDIT_ANYTHING_ELSE;
  if (yes) return { text: M.EDIT_MENU, state: 'FF_EDIT_MENU' };
  return showSummary(ctx, { updated: true });
};
editMoreHandler.prompt = () => M.EDIT_ANYTHING_ELSE;
on('FF_EDIT_MORE', editMoreHandler);

/* ------------------------------------------------------------------ *
 * Nanny search + listing
 * ------------------------------------------------------------------ */

export async function searchNannies(ctx) {
  const d = ctx.session.data || {};
  const preview = draftToBooking(ctx);

  const nannies = await findNannies({
    languages: d.languages || [],
    skills: d.skills || [],
    subjects: d.subjects || [],
    budgetMin: d.budgetMin,
    budgetMax: d.budgetMax,
    cpr: d.cpr,
    serviceDays: preview.serviceDays,
    hoursPerDay: d.hoursPerDay,
  });

  if (!nannies.length) {
    return [
      { text: M.SEARCHING },
      { text: M.NO_NANNIES, state: 'FF_NO_NANNIES' },
    ];
  }

  const ids = nannies.map((n) => String(n._id));
  const page = nannies.slice(0, 3);

  return [
    { text: M.SEARCHING },
    {
      text: M.nannyListing(page, { startIndex: 0, total: nannies.length }),
      state: 'FF_NANNY_LISTING',
      listing: { kind: 'nannies', ids, page: 0, pageSize: 3 },
    },
  ];
}

const noNanniesHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, 4);
  if (!choice) return M.NO_NANNIES;
  if (choice === 1) return { text: M.ASK_SKILLS, state: 'FF_EDIT_SKILLS' };
  if (choice === 2) return { text: M.ASK_START_DATE, state: 'FF_START_DATE' };
  if (choice === 3) return { text: 'Connecting you to support…', state: 'SUPPORT_MENU' };
  return { text: M.FAMILY_MAIN_MENU, state: 'FAMILY_MAIN_MENU', resetData: true };
};
noNanniesHandler.prompt = () => M.NO_NANNIES;
on('FF_NO_NANNIES', noNanniesHandler);

/** Render the current page of the nanny listing. */
export async function renderListingPage(ctx) {
  const listing = ctx.session.listing;
  if (!listing?.ids?.length) return null;
  const start = listing.page * listing.pageSize;
  const ids = listing.ids.slice(start, start + listing.pageSize);
  if (!ids.length) return null;
  const nannies = await User.find({ _id: { $in: ids } });
  // Preserve the ranked order from the search.
  nannies.sort((a, b) => ids.indexOf(String(a._id)) - ids.indexOf(String(b._id)));
  return M.nannyListing(nannies, { startIndex: start, total: listing.ids.length });
}

const listingHandler = async (ctx) => {
  const listing = ctx.session.listing;
  if (!listing?.ids?.length) return startFindNanny(ctx);

  if (ctx.command === 'NEXT') {
    const maxPage = Math.ceil(listing.ids.length / listing.pageSize) - 1;
    if (listing.page >= maxPage) {
      return `You've reached the end of the list.\n\n${await renderListingPage(ctx)}`;
    }
    listing.page += 1;
    ctx.session.listing = listing;
    ctx.session.markModified('listing');
    return await renderListingPage(ctx);
  }

  const globalIndex = parseChoice(ctx.text, listing.ids.length);
  if (!globalIndex) return M.INVALID_CHOICE;

  const start = listing.page * listing.pageSize;
  // Accept only numbers shown on the current page.
  if (globalIndex <= start || globalIndex > start + listing.pageSize) {
    return `Please reply with one of the numbers shown above, or type *NEXT* for more profiles.`;
  }

  const nannyId = listing.ids[globalIndex - 1];
  const nanny = await User.findById(nannyId);
  if (!nanny) return M.INVALID_CHOICE;

  ctx.set('selectedNannyId', String(nanny._id));
  return [
    { text: M.nannyProfile(nanny) },
    { text: M.NANNY_PROFILE_ACTIONS, state: 'FF_NANNY_PROFILE' },
  ];
};
listingHandler.prompt = async (ctx) => await renderListingPage(ctx);
on('FF_NANNY_LISTING', listingHandler);

export default { startFindNanny, searchNannies, draftToBooking, showSummary, uniqueLabel, renderListingPage };
