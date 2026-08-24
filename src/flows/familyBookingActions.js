import dayjs from 'dayjs';
import { on } from './engine.js';
import { User, Booking, ChatThread, Ticket, nextSequence } from '../models/index.js';
import {
  BOOKING_STATUS, BOOKING_SUBSTATUS, SERVICE_DAY_STATUS, CANCELLED_BY,
  LANGUAGES, SKILLS, SUBJECTS, DURATION_OPTIONS, TICKET_CATEGORY,
} from '../utils/constants.js';
import {
  parseChoice, parseMultiChoice, pickFrom, parseYesNo, parseDate, parseTime,
  parseMoney, parseMapUrl, clean, lower, parseWeekdays,
} from '../utils/parse.js';
import {
  cancelBooking, recalcServiceDays, openNannyResponseWindow, syncBookingStatus,
} from '../services/booking.js';
import { computeCancellationRefund, computeReschedulePenalty, round2 } from '../services/policy.js';
import { refundBooking, queuePayout, chargeBooking } from '../services/payments.js';
import { findReplacements } from '../services/matching.js';
import { notifyUser } from '../services/notify.js';
import { showBookingDetail, bookingActionMenu, menuText, MY_BOOKINGS_MENU } from './familyMenu.js';
import { openChatWithNanny, setNannyRequestState } from './familyBookingPayment.js';
import { prettyDate, timeRange, money, statusLabel } from '../utils/format.js';
import config from '../config/index.js';
import * as M from '../utils/messages.js';

/** Load the booking the family is currently acting on. */
async function activeBooking(ctx) {
  const id = ctx.get('activeBookingId');
  if (!id) return null;
  return Booking.findById(id);
}

/**
 * Route a numbered choice against the dynamic action menu.
 * The menu is rebuilt so the option labels always match what was displayed.
 */
function makeActionHandler(stateName) {
  const handler = async (ctx) => {
    const booking = await activeBooking(ctx);
    if (!booking) return { text: MY_BOOKINGS_MENU, state: 'FB_BOOKINGS_MENU' };

    const menu = await bookingActionMenu(booking);
    const labels = extractLabels(menu.text);
    const choice = parseChoice(ctx.text, labels.length);
    if (!choice) return menu.text;

    return dispatchAction(ctx, booking, labels[choice - 1]);
  };
  handler.prompt = async (ctx) => {
    const booking = await activeBooking(ctx);
    if (!booking) return MY_BOOKINGS_MENU;
    return (await bookingActionMenu(booking)).text;
  };
  on(stateName, handler);
}

function extractLabels(menuText) {
  return menuText.split('\n')
    .map((l) => l.match(/^\d+\.\s+(.*)$/))
    .filter(Boolean)
    .map((m) => m[1].trim());
}

['FB_ACTION_UPCOMING', 'FB_ACTION_ONGOING', 'FB_ACTION_COMPLETED',
  'FB_ACTION_CANCELLED', 'FB_ACTION_REPLACEMENT', 'FB_ACTION_ADDITIONAL']
  .forEach(makeActionHandler);

/** Map a menu label to its behaviour. */
async function dispatchAction(ctx, booking, label) {
  switch (label) {
    case 'Message Nanny': {
      const nanny = await User.findById(booking.nanny);
      if (!nanny) return 'This booking has no nanny assigned right now.';
      return openChatWithNanny(ctx, nanny, booking);
    }
    case 'View Nanny Profile': {
      const nanny = await User.findById(booking.nanny);
      if (!nanny) return 'This booking has no nanny assigned right now.';
      const menu = await bookingActionMenu(booking);
      return [
        { text: M.nannyProfile(nanny, { hourlyRate: booking.hourlyRate }) },
        { text: menu.text, state: menu.state },
      ];
    }
    case 'Confirm Nanny Arrival':
      return showArrivalCode(ctx, booking);
    case 'Show End-of-Service Code':
      return showEndCode(ctx, booking);
    case 'Reschedule Booking':
      return startReschedule(ctx, booking);
    case 'Change Address':
      return { text: M.ASK_LOCATION, state: 'FB_CHANGE_ADDRESS_MAP' };
    case 'Change Skills, Language or Budget':
      return { text: CHANGE_REQ_MENU, state: 'FB_CHANGE_REQ_MENU' };
    case 'Change Nanny':
    case 'View Replacement Nannies':
      return showReplacementNannies(ctx, booking);
    case 'Show nannies within my previous budget':
      return showReplacementNannies(ctx, booking, { withinBudget: true });
    case 'Pay Now':
      return startAdditionalPayment(ctx, booking);
    case 'Cancel Booking':
      return startCancellation(ctx, booking);
    case 'Start Sharing Live Location':
      return startLiveLocation(ctx, booking);
    case 'Stop Sharing Live Location':
      return stopLiveLocation(ctx, booking);
    case "View Nanny's Live Location":
      return viewNannyLocation(ctx, booking);
    case 'Report an Issue':
    case 'Contact Support':
      return { text: REPORT_ISSUE_PROMPT, state: 'FB_REPORT_ISSUE' };
    case 'Rate Nanny':
      return startRating(ctx, booking);
    case 'Book this Nanny Again':
      return bookAgain(ctx, booking);
    case 'Download Payment Receipt':
      return sendReceipt(ctx, booking);
    default:
      return M.INVALID_CHOICE;
  }
}

/* ------------------------------------------------------------------ *
 * OTP / service codes
 * ------------------------------------------------------------------ */

async function showArrivalCode(ctx, booking) {
  const day = booking.currentDay();
  if (!day) return 'There is no service scheduled right now.';
  const menu = await bookingActionMenu(booking);
  return [
    {
      text: `🔐 Your ARRIVAL verification code is *${day.arrivalOtp}*.

Please give this code to your nanny so she can confirm her arrival.

Only share it once the nanny is at your door.`,
    },
    { text: menu.text, state: menu.state },
  ];
}

async function showEndCode(ctx, booking) {
  const day = booking.currentDay();
  if (!day) return 'There is no service in progress right now.';
  return {
    text: `Your service has ended. It's time for the nanny to leave.

🔐 Your END-OF-SERVICE verification code is *${day.endOtp}*.

Please give this code to your nanny so we can confirm her service has ended.
Don't share the code until the nanny's service duration ends for today.

What would you like to do?

1. Contact Support

Type *Back* to go back to My Bookings`,
    state: 'FB_END_CODE_SHOWN',
  };
}

on('FB_END_CODE_SHOWN', async (ctx) => {
  const choice = parseChoice(ctx.text, 1);
  if (choice === 1) return { text: REPORT_ISSUE_PROMPT, state: 'FB_REPORT_ISSUE' };
  return { text: MY_BOOKINGS_MENU, state: 'FB_BOOKINGS_MENU' };
});

/* ------------------------------------------------------------------ *
 * Reschedule
 * ------------------------------------------------------------------ */

async function startReschedule(ctx, booking) {
  // Spec: a single-day ongoing booking cannot be rescheduled.
  if (booking.status === BOOKING_STATUS.ONGOING && !booking.isMultiDay) {
    const menu = await bookingActionMenu(booking);
    return [
      { text: '⚠️ A single-day booking that has already started cannot be rescheduled.\n\nIf you are not happy with the nanny you can cancel and book again.' },
      { text: menu.text, state: menu.state },
    ];
  }

  const info = computeReschedulePenalty(booking, booking.remainingDays().map((d) => d._id));
  const warn = info.free
    ? `You have used *${info.reschedulesUsed}* of *${info.freeLimit}* free reschedules.`
    : `⚠️ You have used your ${info.freeLimit} free reschedules. A *${config.reschedulePenaltyPercent}%* penalty applies to the rescheduled day(s).`;

  return {
    text: `🔄 *Reschedule Booking*

${warn}

What would you like to change?

1. Start Date
2. Start Time
3. Duration per day
${booking.isMultiDay ? '4. Repeat Days\n' : ''}
Type *Back* to cancel rescheduling.`,
    state: 'FB_RESCHEDULE_MENU',
  };
}

on('FB_RESCHEDULE_MENU', async (ctx) => {
  const booking = await activeBooking(ctx);
  if (!booking) return { text: MY_BOOKINGS_MENU, state: 'FB_BOOKINGS_MENU' };
  const max = booking.isMultiDay ? 4 : 3;
  const choice = parseChoice(ctx.text, max);
  if (!choice) return M.INVALID_CHOICE;

  const routes = {
    1: { text: M.ASK_START_DATE, state: 'FB_RESCHEDULE_DATE' },
    2: { text: M.ASK_START_TIME, state: 'FB_RESCHEDULE_TIME' },
    3: { text: M.ASK_DURATION, state: 'FB_RESCHEDULE_DURATION' },
    4: { text: M.ASK_REPEAT_DAYS, state: 'FB_RESCHEDULE_DAYS' },
  };
  return routes[choice];
});

function rescheduleStep(state, parse, field) {
  const handler = async (ctx) => {
    const booking = await activeBooking(ctx);
    if (!booking) return { text: MY_BOOKINGS_MENU, state: 'FB_BOOKINGS_MENU' };
    const value = parse(ctx.text);
    if (value === null || value === undefined) return '❌ I couldn\'t read that. Please try again.';
    ctx.set('pendingReschedule', { [field]: value });
    return confirmReschedule(ctx, booking, { [field]: value });
  };
  on(state, handler);
}

rescheduleStep('FB_RESCHEDULE_DATE', (t) => parseDate(t), 'startDate');
rescheduleStep('FB_RESCHEDULE_TIME', (t) => parseTime(t), 'startTime');
rescheduleStep('FB_RESCHEDULE_DURATION', (t) => {
  const c = parseChoice(t, DURATION_OPTIONS.length);
  return c ? DURATION_OPTIONS[c - 1] : null;
}, 'hoursPerDay');
rescheduleStep('FB_RESCHEDULE_DAYS', (t) => parseWeekdays(t), 'repeatDays');

async function confirmReschedule(ctx, booking, changes) {
  // A date change shifts the whole range for a multi-day booking.
  if (changes.startDate && booking.isMultiDay) {
    const shift = dayjs(changes.startDate).diff(dayjs(booking.startDate), 'day');
    changes.endDate = dayjs(booking.endDate).add(shift, 'day').format('YYYY-MM-DD');
  } else if (changes.startDate) {
    changes.endDate = changes.startDate;
  }

  const { serviceDays, totalAmount } = recalcServiceDays(booking, changes);
  const affected = serviceDays.filter((d) => d.status === SERVICE_DAY_STATUS.SCHEDULED);
  const penaltyInfo = computeReschedulePenalty(booking, booking.remainingDays().map((d) => d._id));
  const difference = round2(totalAmount - (booking.totalAmount || 0));

  ctx.set('pendingReschedule', { ...changes, totalAmount, penalty: penaltyInfo.penalty, difference });

  const lines = ['🔄 *Please confirm your changes*', ''];
  if (changes.startDate) lines.push(`📅 New start date: ${prettyDate(changes.startDate)}`);
  if (changes.endDate && booking.isMultiDay) lines.push(`📅 New end date: ${prettyDate(changes.endDate)}`);
  if (changes.startTime) lines.push(`🕘 New time: ${timeRange(changes.startTime, changes.hoursPerDay ?? booking.hoursPerDay)}`);
  if (changes.hoursPerDay) lines.push(`⏱ New duration: ${changes.hoursPerDay} hrs per day`);
  if (changes.repeatDays) lines.push(`🔄 Repeat on: ${changes.repeatDays.join(', ')}`);
  lines.push('', `Service days: *${affected.length}*`, `New total: *${money(totalAmount)}*`);
  if (difference > 0) lines.push(`💰 Additional payment due: *${money(difference)}*`);
  if (difference < 0) lines.push(`💰 Refund due: *${money(Math.abs(difference))}*`);
  if (penaltyInfo.penalty > 0) lines.push(`⚠️ Reschedule penalty (${penaltyInfo.percent}%): *${money(penaltyInfo.penalty)}*`);
  lines.push('', 'The nanny has *2 hours* to accept these changes.', '', '1. Confirm Changes', '2. Cancel');

  return { text: lines.join('\n'), state: 'FB_RESCHEDULE_CONFIRM' };
}

on('FB_RESCHEDULE_CONFIRM', async (ctx) => {
  const choice = parseChoice(ctx.text, 2);
  if (!choice) return M.INVALID_CHOICE;

  const booking = await activeBooking(ctx);
  if (!booking) return { text: MY_BOOKINGS_MENU, state: 'FB_BOOKINGS_MENU' };

  if (choice === 2) {
    const menu = await bookingActionMenu(booking);
    return [{ text: 'Rescheduling cancelled.' }, { text: menu.text, state: menu.state }];
  }

  const pending = ctx.get('pendingReschedule') || {};
  booking.pendingChange = { kind: 'reschedule', ...pending };
  booking.rescheduleCount = (booking.rescheduleCount || 0) + 1;

  // Spec: the assigned nanny gets 2 hours to accept an existing-booking change.
  if (booking.nanny) {
    const family = await User.findById(booking.family);
    const { expiresAt } = openNannyResponseWindow(booking, booking.nanny, 'booking_change');
    await booking.save();

    const nanny = await User.findById(booking.nanny);
    const preview = { ...booking.toObject(), ...pending };
    await notifyUser(nanny, M.nannyBookingRequest(preview, family, expiresAt, { isChange: true }));
    await setNannyRequestState(nanny, booking);

    return {
      text: `✅ Your change request has been sent to ${nanny.fullName}.

She has *2 hours* to accept the changes. We'll let you know as soon as she responds.

While we wait, we won't show you other nannies.`,
      state: 'FAMILY_MAIN_MENU',
    };
  }

  // No nanny assigned — apply immediately.
  await applyPendingChange(booking);
  return { text: '✅ Your booking has been updated.', state: 'FAMILY_MAIN_MENU' };
});

/** Apply a change the nanny accepted (or that needed no approval). */
export async function applyPendingChange(booking) {
  const change = booking.pendingChange;
  if (!change) return booking;

  if (change.kind === 'reschedule') {
    const { serviceDays, totalAmount, merged } = recalcServiceDays(booking, change);
    booking.serviceDays = serviceDays;
    booking.totalAmount = totalAmount;
    booking.startDate = merged.startDate;
    booking.endDate = merged.endDate;
    booking.startTime = merged.startTime;
    booking.hoursPerDay = merged.hoursPerDay;
    booking.repeatDays = merged.repeatDays;
    booking.markModified('serviceDays');
  } else if (change.kind === 'address') {
    booking.address = change.address;
  } else if (change.kind === 'requirements') {
    booking.requirements = { ...booking.requirements, ...change.requirements };
  }

  booking.pendingChange = undefined;
  booking.subStatus = booking.nanny
    ? BOOKING_SUBSTATUS.NANNY_CONFIRMED
    : BOOKING_SUBSTATUS.AWAITING_NANNY_CONFIRMATION;
  syncBookingStatus(booking);
  await booking.save();
  return booking;
}

/* ------------------------------------------------------------------ *
 * Change address / requirements
 * ------------------------------------------------------------------ */

on('FB_CHANGE_ADDRESS_MAP', async (ctx) => {
  const parsed = parseMapUrl(ctx.text);
  if (!parsed) return '❌ Please share a Google Maps link, or type *None*.';
  ctx.set('newMapUrl', parsed.url);
  return { text: M.ASK_ADDRESS, state: 'FB_CHANGE_ADDRESS_LINE' };
});

on('FB_CHANGE_ADDRESS_LINE', async (ctx) => {
  const line = clean(ctx.text);
  if (line.length < 3) return M.ASK_ADDRESS;
  const booking = await activeBooking(ctx);
  if (!booking) return { text: MY_BOOKINGS_MENU, state: 'FB_BOOKINGS_MENU' };

  booking.pendingChange = {
    kind: 'address',
    address: { mapUrl: ctx.get('newMapUrl'), addressLine: line },
  };
  return sendChangeToNanny(ctx, booking, '📍 Address change');
});

export const CHANGE_REQ_MENU = `What would you like to change?

1. Languages
2. Skills
3. Subjects
4. Budget

Type *Back* to go back.`;

on('FB_CHANGE_REQ_MENU', async (ctx) => {
  const choice = parseChoice(ctx.text, 4);
  if (!choice) return CHANGE_REQ_MENU;
  const routes = {
    1: { text: M.ASK_LANGUAGES, state: 'FB_CHANGE_LANGUAGES' },
    2: { text: M.ASK_SKILLS, state: 'FB_CHANGE_SKILLS' },
    3: { text: M.ASK_SUBJECTS, state: 'FB_CHANGE_SUBJECTS' },
    4: { text: M.ASK_BUDGET_MIN, state: 'FB_CHANGE_BUDGET_MIN' },
  };
  return routes[choice];
});

function changeReqStep(state, catalog, field) {
  on(state, async (ctx) => {
    const idx = parseMultiChoice(ctx.text, catalog.length);
    if (!idx) return M.INVALID_CHOICE;
    const booking = await activeBooking(ctx);
    if (!booking) return { text: MY_BOOKINGS_MENU, state: 'FB_BOOKINGS_MENU' };
    booking.pendingChange = {
      kind: 'requirements',
      requirements: { [field]: pickFrom(catalog, idx) },
    };
    return sendChangeToNanny(ctx, booking, `🛠 ${field} change`);
  });
}
changeReqStep('FB_CHANGE_LANGUAGES', LANGUAGES, 'languages');
changeReqStep('FB_CHANGE_SKILLS', SKILLS, 'skills');
changeReqStep('FB_CHANGE_SUBJECTS', SUBJECTS, 'subjects');

on('FB_CHANGE_BUDGET_MIN', async (ctx) => {
  const v = parseMoney(ctx.text);
  if (v === null) return '❌ Please enter an amount, for example *$25*.';
  ctx.set('newBudgetMin', v);
  return { text: M.ASK_BUDGET_MAX, state: 'FB_CHANGE_BUDGET_MAX' };
});

on('FB_CHANGE_BUDGET_MAX', async (ctx) => {
  const v = parseMoney(ctx.text);
  if (v === null) return '❌ Please enter an amount, for example *$45*.';
  const booking = await activeBooking(ctx);
  if (!booking) return { text: MY_BOOKINGS_MENU, state: 'FB_BOOKINGS_MENU' };
  booking.pendingChange = {
    kind: 'requirements',
    requirements: { budgetMin: ctx.get('newBudgetMin'), budgetMax: v },
  };
  return sendChangeToNanny(ctx, booking, '💰 Budget change');
});

/**
 * Route a change through the nanny's 2-hour approval window, or apply it
 * immediately when nobody is assigned.
 */
async function sendChangeToNanny(ctx, booking, label) {
  if (!booking.nanny) {
    await applyPendingChange(booking);
    const menu = await bookingActionMenu(booking);
    return [
      { text: `✅ ${label} saved.` },
      { text: menu.text, state: menu.state },
    ];
  }

  const family = await User.findById(booking.family);
  const { expiresAt } = openNannyResponseWindow(booking, booking.nanny, 'booking_change');
  await booking.save();

  const nanny = await User.findById(booking.nanny);
  const preview = { ...booking.toObject(), ...(booking.pendingChange?.address ? { address: booking.pendingChange.address } : {}) };
  await notifyUser(nanny, M.nannyBookingRequest(preview, family, expiresAt, { isChange: true }));
  await setNannyRequestState(nanny, booking);

  return {
    text: `✅ ${label} sent to ${nanny.fullName}.

She has *2 hours* to accept. We'll notify you as soon as she responds.`,
    state: 'FAMILY_MAIN_MENU',
  };
}

/* ------------------------------------------------------------------ *
 * Replacement / change nanny
 * ------------------------------------------------------------------ */

async function showReplacementNannies(ctx, booking, { withinBudget = false } = {}) {
  // Spec: never show alternatives while the current nanny still owns the clock.
  const { isInResponseWindow } = await import('../services/booking.js');
  if (isInResponseWindow(booking) && booking.nanny) {
    const pending = booking.nannyResponses.find((r) => r.outcome === 'pending');
    const mins = Math.max(1, Math.round((new Date(pending.expiresAt) - Date.now()) / 60000));
    return `⏳ Your nanny still has *${mins} minutes* to respond.

We'll show you other nannies if she declines or doesn't respond in time.`;
  }

  const nannies = await findReplacements(booking, { includeOverBudget: !withinBudget });
  if (!nannies.length) {
    return `😔 We couldn't find a replacement nanny right now.

1. Cancel Booking
2. Contact Support`;
  }

  const ids = nannies.map((n) => String(n._id));
  return {
    text: M.nannyListing(nannies.slice(0, 3), { startIndex: 0, total: nannies.length }),
    state: 'FB_REPLACEMENT_LISTING',
    listing: { kind: 'replacements', ids, page: 0, pageSize: 3 },
  };
}

on('FB_REPLACEMENT_LISTING', async (ctx) => {
  const listing = ctx.session.listing;
  if (!listing?.ids?.length) return { text: MY_BOOKINGS_MENU, state: 'FB_BOOKINGS_MENU' };

  if (ctx.command === 'NEXT') {
    const maxPage = Math.ceil(listing.ids.length / listing.pageSize) - 1;
    if (listing.page < maxPage) {
      listing.page += 1;
      ctx.session.listing = listing;
      ctx.session.markModified('listing');
    }
    const start = listing.page * listing.pageSize;
    const page = await User.find({ _id: { $in: listing.ids.slice(start, start + listing.pageSize) } });
    return M.nannyListing(page, { startIndex: start, total: listing.ids.length });
  }

  const n = parseChoice(ctx.text, listing.ids.length);
  if (!n) return M.INVALID_CHOICE;

  const nanny = await User.findById(listing.ids[n - 1]);
  if (!nanny) return M.INVALID_CHOICE;

  const booking = await activeBooking(ctx);
  if (!booking) return { text: MY_BOOKINGS_MENU, state: 'FB_BOOKINGS_MENU' };

  ctx.set('replacementNannyId', String(nanny._id));

  const remainingHours = booking.remainingDays().reduce((s, d) => s + (d.hours || 0), 0);
  const difference = round2((nanny.hourlyRate - booking.hourlyRate) * remainingHours);

  const lines = [M.nannyProfile(nanny), ''];
  if (difference > 0) {
    lines.push(`⚠️ This nanny costs *${money(nanny.hourlyRate)}/hr* — ${money(difference)} more than your current booking.`);
    lines.push('You will need to pay the difference before the booking is confirmed.');
  } else if (difference < 0) {
    lines.push(`✅ This nanny costs less. *${money(Math.abs(difference))}* will be refunded to you.`);
  }
  lines.push('', '1. Select this Nanny', '2. View Other Nannies');

  return { text: lines.join('\n'), state: 'FB_REPLACEMENT_CONFIRM' };
});

on('FB_REPLACEMENT_CONFIRM', async (ctx) => {
  const choice = parseChoice(ctx.text, 2);
  if (!choice) return M.INVALID_CHOICE;

  const booking = await activeBooking(ctx);
  if (!booking) return { text: MY_BOOKINGS_MENU, state: 'FB_BOOKINGS_MENU' };

  if (choice === 2) return showReplacementNannies(ctx, booking);

  const nanny = await User.findById(ctx.get('replacementNannyId'));
  if (!nanny) return M.INVALID_CHOICE;

  const { assignReplacement } = await import('../services/booking.js');
  const { difference, requiresPayment } = await assignReplacement(booking, nanny);

  if (requiresPayment) {
    ctx.set('additionalPaymentBookingId', String(booking._id));
    return {
      text: `💰 *Additional payment required*

${nanny.fullName} costs ${money(difference)} more than your original booking.

Your booking will move to *Pending for Additional Payment* until this is paid.

1. Pay Now
2. Show nannies within my previous budget
3. Cancel Booking`,
      state: 'FB_ACTION_ADDITIONAL',
    };
  }

  // Cheaper or equal: refund any difference and send the request straight out.
  if (difference < 0) {
    await refundBooking(booking, { amount: Math.abs(difference), reason: 'Replacement nanny cheaper' });
  }

  const family = await User.findById(booking.family);
  const { expiresAt } = openNannyResponseWindow(booking, nanny._id, 'new_booking');
  booking.status = BOOKING_STATUS.UPCOMING;
  await booking.save();

  await notifyUser(nanny, M.nannyBookingRequest(booking, family, expiresAt));
  await setNannyRequestState(nanny, booking);

  return {
    text: `✅ ${nanny.fullName} has been selected. Waiting for her confirmation.

We'll notify you as soon as she responds.`,
    state: 'FAMILY_MAIN_MENU',
  };
});

async function startAdditionalPayment(ctx, booking) {
  ctx.set('additionalPaymentBookingId', String(booking._id));
  return {
    text: `💰 Amount due: *${money(booking.additionalDue)}*\n\n${M.ASK_PAYMENT_METHOD}`,
    state: 'FF_PAYMENT_METHOD',
  };
}

/* ------------------------------------------------------------------ *
 * Cancellation
 * ------------------------------------------------------------------ */

async function startCancellation(ctx, booking) {
  const preview = computeCancellationRefund(booking, { cancelledBy: CANCELLED_BY.FAMILY });
  const lines = ['❌ *Cancel Booking*', '', `Booking ID# ${booking.bookingNumber}`, ''];

  if (preview.completedAmount > 0) {
    lines.push(`✅ Completed services: *${money(preview.completedAmount)}* (not refundable)`);
  }
  lines.push(`💰 Refund you will receive: *${money(preview.totalRefund)}*`);
  if (preview.totalNannyCompensation > 0) {
    lines.push(`👩 Nanny compensation: *${money(preview.totalNannyCompensation)}*`);
  }
  const bands = [...new Set(preview.perDay.map((p) => p.band))].filter((b) => b !== 'completed (not refundable)');
  if (bands.length) lines.push('', `_Policy applied: ${bands.join(', ')}_`);

  lines.push('', 'Are you sure you want to cancel this booking?', '', '1. Yes, cancel the booking', '2. No, keep my booking');
  return { text: lines.join('\n'), state: 'FB_CANCEL_CONFIRM' };
}

on('FB_CANCEL_CONFIRM', async (ctx) => {
  const choice = parseChoice(ctx.text, 2);
  if (!choice) return M.INVALID_CHOICE;

  const booking = await activeBooking(ctx);
  if (!booking) return { text: MY_BOOKINGS_MENU, state: 'FB_BOOKINGS_MENU' };

  if (choice === 2) {
    const menu = await bookingActionMenu(booking);
    return [{ text: 'Your booking has been kept.' }, { text: menu.text, state: menu.state }];
  }

  const nannyId = booking.nanny;
  const breakdown = await cancelBooking(booking, {
    cancelledBy: CANCELLED_BY.FAMILY,
    reason: 'Cancelled by family',
  });

  if (breakdown.totalRefund > 0) {
    await refundBooking(booking, {
      amount: breakdown.totalRefund, breakdown, reason: 'Family cancellation',
    });
  }
  if (breakdown.totalNannyCompensation > 0 && nannyId) {
    await queuePayout(booking, {
      nannyId,
      amount: breakdown.totalNannyCompensation,
      isFinal: true,
      notes: 'Cancellation compensation',
    });
  }

  if (nannyId) {
    const nanny = await User.findById(nannyId);
    await notifyUser(nanny, `🔴 *Booking Cancelled*

Booking ID# ${booking.bookingNumber} has been cancelled by the family.

${breakdown.totalNannyCompensation > 0
      ? `💰 You will receive *${money(breakdown.totalNannyCompensation)}* in compensation, released on the next payout Monday.`
      : 'No compensation applies to this cancellation.'}`);
  }

  return {
    text: `🔴 *Booking Cancelled*

Booking ID# ${booking.bookingNumber} has been cancelled.

💰 Refund: *${money(breakdown.totalRefund)}*
${breakdown.totalRefund > 0 ? '\nYour refund is being processed and will reach you in 5–7 business days.' : ''}

Type *0* to return to the Main Menu.`,
    state: 'FAMILY_MAIN_MENU',
    resetData: true,
  };
});

/* ------------------------------------------------------------------ *
 * Live location
 * ------------------------------------------------------------------ */

async function startLiveLocation(ctx, booking) {
  const first = booking.serviceDays?.[0];
  const opensAt = first ? new Date(new Date(first.startAt) - config.liveLocationWindowHours * 3600e3) : null;
  if (opensAt && new Date() < opensAt) {
    return `📍 Live location sharing opens *${config.liveLocationWindowHours} hours* before your service starts.`;
  }
  booking.liveLocation = { ...(booking.liveLocation || {}), familySharing: true, updatedAt: new Date() };
  await booking.save();

  const nanny = await User.findById(booking.nanny);
  if (nanny) {
    await notifyUser(nanny, `📍 The family has started sharing their live location for Booking #${booking.bookingNumber}.`);
  }
  const menu = await bookingActionMenu(booking);
  return [
    { text: '📍 You are now sharing your live location with your nanny.\n\nSend a location message any time to update it.\nType *STOP* to stop sharing.' },
    { text: menu.text, state: menu.state },
  ];
}

async function stopLiveLocation(ctx, booking) {
  booking.liveLocation = { ...(booking.liveLocation || {}), familySharing: false, updatedAt: new Date() };
  await booking.save();
  const menu = await bookingActionMenu(booking);
  return [
    { text: '📍 You have stopped sharing your live location.' },
    { text: menu.text, state: menu.state },
  ];
}

async function viewNannyLocation(ctx, booking) {
  const loc = booking.liveLocation;
  const menu = await bookingActionMenu(booking);
  if (!loc?.nannySharing || !loc.lastNannyLocation) {
    return [
      { text: '📍 Your nanny is not sharing her live location right now.' },
      { text: menu.text, state: menu.state },
    ];
  }
  return [
    { text: `📍 *Your nanny's live location*\n${loc.lastNannyLocation}\n\n_Updated ${dayjs(loc.updatedAt).format('HH:mm')}_` },
    { text: menu.text, state: menu.state },
  ];
}

/* ------------------------------------------------------------------ *
 * Rating / rebook / receipt
 * ------------------------------------------------------------------ */

async function startRating(ctx, booking) {
  if (booking.rating?.stars) {
    const menu = await bookingActionMenu(booking);
    return [
      { text: `You already rated this booking ⭐${booking.rating.stars}.` },
      { text: menu.text, state: menu.state },
    ];
  }
  const nanny = await User.findById(booking.nanny);
  return {
    text: `⭐ *Rate your nanny*

How was your experience with ${nanny?.fullName || 'your nanny'}?

Reply with a rating from *1* to *5*.`,
    state: 'FB_RATING_STARS',
  };
}

on('FB_RATING_STARS', async (ctx) => {
  const stars = parseChoice(ctx.text, 5);
  if (!stars) return 'Please reply with a number from *1* to *5*.';
  ctx.set('pendingStars', stars);
  return {
    text: `Thank you! Would you like to leave a short review?\n\nType your review, or type *Skip*.`,
    state: 'FB_RATING_REVIEW',
  };
});

on('FB_RATING_REVIEW', async (ctx) => {
  const booking = await activeBooking(ctx);
  if (!booking) return { text: MY_BOOKINGS_MENU, state: 'FB_BOOKINGS_MENU' };

  const stars = ctx.get('pendingStars', 5);
  const review = ctx.command === 'SKIP' ? '' : clean(ctx.text);

  booking.rating = { stars, review, ratedAt: new Date() };
  await booking.save();

  // Roll the new score into the nanny's running average.
  const nanny = await User.findById(booking.nanny);
  if (nanny) {
    const count = (nanny.ratingCount || 0) + 1;
    const avg = ((nanny.ratingAverage || 0) * (nanny.ratingCount || 0) + stars) / count;
    nanny.ratingCount = count;
    nanny.ratingAverage = Math.round(avg * 10) / 10;
    await nanny.save();
    await notifyUser(nanny, `⭐ You received a *${stars}-star* rating for Booking #${booking.bookingNumber}!${review ? `\n\n"${review}"` : ''}`);
  }

  return {
    text: `✅ Thank you for your feedback!\n\nType *0* to return to the Main Menu.`,
    state: 'FAMILY_MAIN_MENU',
  };
});

async function bookAgain(ctx, booking) {
  const nanny = await User.findById(booking.nanny);
  if (!nanny) return 'That nanny is no longer available.';

  // Pre-fill a new draft from the completed booking.
  ctx.session.data = {
    address: booking.address,
    mapUrl: booking.address?.mapUrl,
    addressLine: booking.address?.addressLine,
    languages: booking.requirements?.languages || [],
    skills: booking.requirements?.skills || [],
    subjects: booking.requirements?.subjects || [],
    budgetMin: booking.requirements?.budgetMin,
    budgetMax: booking.requirements?.budgetMax,
    cpr: booking.requirements?.cpr,
    children: booking.children || [],
    childCount: (booking.children || []).length,
    otherInstructions: booking.otherInstructions,
    hoursPerDay: booking.hoursPerDay,
    startTime: booking.startTime,
    selectedNannyId: String(nanny._id),
  };
  ctx.session.markModified('data');

  return {
    text: `🔄 *Book ${nanny.fullName} again*\n\nWe've kept your previous details.\n\n${M.ASK_FREQUENCY}`,
    state: 'FF_FREQUENCY',
  };
}

async function sendReceipt(ctx, booking) {
  const nanny = await User.findById(booking.nanny);
  const menu = await bookingActionMenu(booking);
  const lines = [
    '🧾 *Payment Receipt*',
    '',
    `Booking ID# ${booking.bookingNumber}`,
    `Date: ${prettyDate(booking.startDate)}${booking.isMultiDay ? ` – ${prettyDate(booking.endDate)}` : ''}`,
    nanny ? `Nanny: ${nanny.fullName}` : '',
    '',
    `Rate: ${money(booking.hourlyRate)}/hr`,
    `Hours per day: ${booking.hoursPerDay}`,
    `Service days: ${(booking.serviceDays || []).length}`,
    '',
    `Subtotal: ${money(booking.totalAmount)}`,
    booking.refundedAmount > 0 ? `Refunded: -${money(booking.refundedAmount)}` : '',
    `*Total Paid: ${money(booking.paidAmount)}*`,
    '',
    `_Receipt generated ${dayjs().format('D MMMM YYYY')}_`,
  ].filter(Boolean);

  return [
    { text: lines.join('\n') },
    { text: menu.text, state: menu.state },
  ];
}

/* ------------------------------------------------------------------ *
 * Report an issue -> support ticket
 * ------------------------------------------------------------------ */

export const REPORT_ISSUE_PROMPT = `🆘 Please describe the issue you're experiencing.

Type your message and our support team will get back to you.`;

on('FB_REPORT_ISSUE', async (ctx) => {
  const description = clean(ctx.text);
  if (description.length < 5) return REPORT_ISSUE_PROMPT;

  const booking = await activeBooking(ctx);
  const ticketNumber = `T-${await nextSequence('ticket', 1000)}`;

  await Ticket.create({
    ticketNumber,
    raisedBy: ctx.session.user,
    raisedByRole: 'family',
    booking: booking?._id,
    category: TICKET_CATEGORY.BOOKING,
    subject: booking ? `Issue with Booking #${booking.bookingNumber}` : 'Support request',
    description,
  });

  return {
    text: `✅ Your ticket *${ticketNumber}* has been created.

Our support team will contact you shortly.

Type *0* to return to the Main Menu.`,
    state: 'FAMILY_MAIN_MENU',
  };
});

export default { applyPendingChange, CHANGE_REQ_MENU, REPORT_ISSUE_PROMPT };
