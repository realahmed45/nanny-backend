import dayjs from 'dayjs';
import { on } from './engine.js';
import { User, Booking, ChatThread, Ticket, Payout, nextSequence } from '../models/index.js';
import {
  BOOKING_STATUS, BOOKING_SUBSTATUS, SERVICE_DAY_STATUS, NANNY_STATUS,
  CANCELLED_BY, PAYOUT_STATUS, TICKET_CATEGORY, WEEKDAYS, DURATION_OPTIONS,
} from '../utils/constants.js';
import {
  parseChoice, parseServiceCode, parseDate, parseTime, parseMoney,
  parseWeekdays, parseMultiChoice, pickFrom, clean, lower,
} from '../utils/parse.js';
import {
  syncBookingStatus, markNannyCancelled, cancelBooking,
} from '../services/booking.js';
import { computeCancellationRefund, computeOvertimeHours, round2 } from '../services/policy.js';
import { queuePayout, refundBooking, dayEarnings } from '../services/payments.js';
import { findReplacements } from '../services/matching.js';
import { notifyUser } from '../services/notify.js';
import { applyPendingChange } from './familyBookingActions.js';
import { statusLabel, prettyDate, timeRange, money } from '../utils/format.js';
import config from '../config/index.js';
import * as M from '../utils/messages.js';

export const NANNY_BOOKINGS_MENU = `📅 *My Bookings*

Choose a category:

1. Upcoming
2. Ongoing
3. Completed
4. Cancelled

Type *0* Return to Main Menu`;

export const NANNY_AVAILABILITY_MENU = `📆 *My Availability*

What would you like to do?

1. View My Availability
2. Change Available Days
3. Change Start Time
4. Change Daily Hours
5. Block Specific Dates
6. Unblock Dates

Type *0* Return to Main Menu`;

export const NANNY_PROFILE_MENU = `👤 *My Profile*

What would you like to do?

1. View My Profile
2. Change Hourly Rate
3. Manage Skills
4. Manage Languages
5. Manage Documents
6. Emergency Contacts

Type *0* Return to Main Menu`;

export const NANNY_PAYMENTS_MENU = `💰 *Payments*

Choose a category:

1. Payment Pending
2. Payment Processing
3. Payment Completed
4. Final Payment Done & Finished
5. Payment Failed

Type *0* Return to Main Menu`;

export const NANNY_SUPPORT_MENU = `🆘 *Help / Support*

What do you need help with?

1. 📅 Booking Issue
2. 💳 Payment Issue
3. 👨‍👩‍👧 Family Issue
4. 👤 Account Issue
5. 📄 View My Tickets
6. ℹ️ Commands & How It Works

Type *0* Return to Main Menu`;

/* ------------------------------------------------------------------ *
 * Main menu
 * ------------------------------------------------------------------ */

const nannyMenuHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, 7);
  if (!choice) return M.NANNY_MAIN_MENU;

  const user = await User.findById(ctx.session.user);
  if (user && user.nannyStatus !== NANNY_STATUS.VERIFIED) {
    return `⏳ Your profile is still under review. You'll be able to use this menu once you're approved.`;
  }

  switch (choice) {
    case 1: return showPendingRequests(ctx);
    case 2: return { text: NANNY_BOOKINGS_MENU, state: 'NB_BOOKINGS_MENU' };
    case 3: return { text: NANNY_AVAILABILITY_MENU, state: 'NA_MENU' };
    case 4: return { text: NANNY_PROFILE_MENU, state: 'NP_MENU' };
    case 5: return { text: NANNY_PAYMENTS_MENU, state: 'NPAY_MENU' };
    case 6: return showNannyReferral(ctx);
    case 7: return { text: NANNY_SUPPORT_MENU, state: 'NSUP_MENU' };
    default: return M.NANNY_MAIN_MENU;
  }
};
nannyMenuHandler.prompt = () => M.NANNY_MAIN_MENU;
on('NANNY_MAIN_MENU', nannyMenuHandler);

/* ------------------------------------------------------------------ *
 * Booking requests (accept / decline within the response window)
 * ------------------------------------------------------------------ */

async function showPendingRequests(ctx) {
  const bookings = await Booking.find({
    nanny: ctx.session.user,
    'nannyResponses.outcome': 'pending',
    status: { $in: [BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING] },
  });

  const live = bookings.filter((b) => {
    const p = b.nannyResponses.find((r) => r.outcome === 'pending');
    return p && new Date(p.expiresAt) > new Date();
  });

  if (!live.length) {
    return `📭 You have no pending booking requests right now.\n\nWe'll message you as soon as a family books you.\n\nType *0* to return to the Main Menu.`;
  }

  if (live.length === 1) {
    const b = live[0];
    const family = await User.findById(b.family);
    const p = b.nannyResponses.find((r) => r.outcome === 'pending');
    ctx.set('requestBookingId', String(b._id));
    return {
      text: M.nannyBookingRequest(b, family, p.expiresAt, { isChange: p.kind === 'booking_change' }),
      state: 'NANNY_BOOKING_REQUEST',
    };
  }

  const rows = await Promise.all(live.map(async (b, i) => {
    const family = await User.findById(b.family).select('fullName');
    return `*${i + 1}. Booking ID #${b.bookingNumber}*\n👨‍👩‍👧 ${family?.fullName || 'Family'}\n📅 ${prettyDate(b.startDate)}\n⏰ ${timeRange(b.startTime, b.hoursPerDay)}\n💰 ${money(b.totalAmount)}`;
  }));

  return {
    text: `🔔 You have *${live.length} pending requests*.\n\n${rows.join('\n\n')}\n\nReply with a number to view the request.`,
    state: 'NANNY_REQUEST_LIST',
    listing: { kind: 'requests', ids: live.map((b) => String(b._id)), page: 0, pageSize: 20 },
  };
}

on('NANNY_REQUEST_LIST', async (ctx) => {
  const ids = ctx.session.listing?.ids || [];
  const n = parseChoice(ctx.text, ids.length);
  if (!n) return M.INVALID_CHOICE;

  const booking = await Booking.findById(ids[n - 1]);
  if (!booking) return M.INVALID_CHOICE;

  const family = await User.findById(booking.family);
  const p = booking.nannyResponses.find((r) => r.outcome === 'pending');
  ctx.set('requestBookingId', String(booking._id));

  return {
    text: M.nannyBookingRequest(booking, family, p?.expiresAt, { isChange: p?.kind === 'booking_change' }),
    state: 'NANNY_BOOKING_REQUEST',
  };
});

const requestHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, 3);
  if (!choice) return M.INVALID_CHOICE;

  const booking = await Booking.findById(ctx.get('requestBookingId'));
  if (!booking) {
    return { text: `That request is no longer available.\n\n${M.NANNY_MAIN_MENU}`, state: 'NANNY_MAIN_MENU' };
  }

  const pending = booking.nannyResponses.find((r) => r.outcome === 'pending');
  if (!pending) {
    return { text: `⌛ This request has already been closed.\n\n${M.NANNY_MAIN_MENU}`, state: 'NANNY_MAIN_MENU' };
  }
  if (new Date(pending.expiresAt) < new Date()) {
    return { text: `⌛ This request has expired.\n\n${M.NANNY_MAIN_MENU}`, state: 'NANNY_MAIN_MENU' };
  }

  if (choice === 1) return acceptRequest(ctx, booking, pending);
  if (choice === 2) {
    return {
      text: `Please tell us why you're declining (this helps us match you better).\n\nType your reason, or type *Skip*.`,
      state: 'NANNY_DECLINE_REASON',
    };
  }

  // Message the family.
  const family = await User.findById(booking.family);
  return openNannyChat(ctx, family, booking);
};
requestHandler.prompt = async (ctx) => {
  const booking = await Booking.findById(ctx.get('requestBookingId'));
  if (!booking) return M.NANNY_MAIN_MENU;
  const family = await User.findById(booking.family);
  const p = booking.nannyResponses.find((r) => r.outcome === 'pending');
  return M.nannyBookingRequest(booking, family, p?.expiresAt, { isChange: p?.kind === 'booking_change' });
};
on('NANNY_BOOKING_REQUEST', requestHandler);

async function acceptRequest(ctx, booking, pending) {
  pending.outcome = 'accepted';
  pending.respondedAt = new Date();

  const isChange = pending.kind === 'booking_change';
  const family = await User.findById(booking.family);
  const nanny = await User.findById(ctx.session.user);

  if (isChange) {
    await applyPendingChange(booking);
    await notifyUser(family, `✅ *Booking Updated*

${nanny.fullName} has accepted your changes to Booking #${booking.bookingNumber}.

${M.bookingSummary(booking, { showId: true, nanny, paid: true, showStatus: true })}`);
  } else {
    booking.subStatus = BOOKING_SUBSTATUS.NANNY_CONFIRMED;
    if (booking.status !== BOOKING_STATUS.ONGOING) booking.status = BOOKING_STATUS.UPCOMING;
    await booking.save();
    await notifyUser(family, `🎉 *Booking Confirmed!*

${nanny.fullName} has accepted your booking.

${M.bookingSummary(booking, { showId: true, nanny, paid: true, showStatus: true })}`);
  }

  return {
    text: `✅ *Booking Accepted*

Booking ID# ${booking.bookingNumber}
📅 ${prettyDate(booking.startDate)}${booking.isMultiDay ? ` – ${prettyDate(booking.endDate)}` : ''}
⏰ ${timeRange(booking.startTime, booking.hoursPerDay)}
💰 ${money(booking.totalAmount)}

The family has been notified. You'll get a reminder before the service starts.

Type *0* to return to the Main Menu.`,
    state: 'NANNY_MAIN_MENU',
  };
}

on('NANNY_DECLINE_REASON', async (ctx) => {
  const booking = await Booking.findById(ctx.get('requestBookingId'));
  if (!booking) return { text: M.NANNY_MAIN_MENU, state: 'NANNY_MAIN_MENU' };

  const pending = booking.nannyResponses.find((r) => r.outcome === 'pending');
  if (!pending) return { text: M.NANNY_MAIN_MENU, state: 'NANNY_MAIN_MENU' };

  const reason = ctx.command === 'SKIP' ? 'No reason given' : clean(ctx.text);
  pending.outcome = 'declined';
  pending.respondedAt = new Date();
  pending.declineReason = reason;

  const isChange = pending.kind === 'booking_change';
  const nannyId = booking.nanny;

  if (isChange) {
    // Spec: the original booking stands; the family may now pick someone else.
    booking.pendingChange = undefined;
    booking.subStatus = BOOKING_SUBSTATUS.NANNY_CONFIRMED;
    await booking.save();
  } else {
    if (nannyId && !booking.rejectedNannies.some((id) => String(id) === String(nannyId))) {
      booking.rejectedNannies.push(nannyId);
    }
    booking.nanny = undefined;
    booking.subStatus = BOOKING_SUBSTATUS.NANNY_CANCELLED_AWAITING_REPLACEMENT;
    await booking.save();
  }

  await notifyFamilyOfDecline(booking, isChange);

  return {
    text: `You've declined Booking #${booking.bookingNumber}.\n\nType *0* to return to the Main Menu.`,
    state: 'NANNY_MAIN_MENU',
  };
});

/** Tell the family a nanny said no and offer replacements. */
export async function notifyFamilyOfDecline(booking, isChange) {
  const family = await User.findById(booking.family);
  if (!family) return;

  if (isChange) {
    await notifyUser(family, `⚠️ Your nanny could not accept the changes to Booking #${booking.bookingNumber}.

Your original booking remains unchanged. You can select another nanny from *My Bookings*.`);
    return;
  }

  const replacements = await findReplacements(booking);
  if (!replacements.length) {
    await notifyUser(family, `⚠️ Your selected nanny is unavailable for Booking #${booking.bookingNumber}, and we couldn't find a replacement right now.

Our team will contact you shortly. You can also cancel for a full refund from *My Bookings*.`);
    return;
  }

  const { Session } = await import('../models/index.js');
  const session = await Session.findOne({ phone: family.phone });
  if (session) {
    session.state = 'FB_REPLACEMENT_LISTING';
    session.data = { ...(session.data || {}), activeBookingId: String(booking._id) };
    session.listing = {
      kind: 'replacements',
      ids: replacements.map((n) => String(n._id)),
      page: 0, pageSize: 3,
    };
    session.markModified('data');
    await session.save();
  }

  await notifyUser(family, `⚠️ Your selected nanny is unavailable for Booking #${booking.bookingNumber}.

Here are other available nannies:

${M.nannyListing(replacements.slice(0, 3), { startIndex: 0, total: replacements.length })}`);
}

/* ------------------------------------------------------------------ *
 * Nanny <-> family chat
 * ------------------------------------------------------------------ */

export async function openNannyChat(ctx, family, booking = null) {
  let thread = await ChatThread.findOne({
    family: family._id, nanny: ctx.session.user, booking: booking?._id || null, closed: false,
  });
  if (!thread) {
    thread = await ChatThread.create({
      family: family._id, nanny: ctx.session.user, booking: booking?._id || null,
    });
  }
  thread.nannyActive = true;
  await thread.save();

  return {
    text: `You can now chat with ${family.fullName || 'the family'}.\nYour phone numbers remain private.\nType "*Bye*" at any time to close the chat.`,
    state: 'NANNY_CHATTING',
    activeChat: thread._id,
  };
}

const nannyChatHandler = async (ctx) => {
  const text = clean(ctx.text);

  // '0' escapes the relay the same way BYE does, so a user can never be
  // trapped in chat mode with no way back to the menu.
  const leaving = lower(text) === 'bye' || text === '0';
  if (leaving) {
    const thread = await ChatThread.findById(ctx.session.activeChat);
    if (thread) {
      thread.nannyActive = false;
      await thread.save();
      const family = await User.findById(thread.family);
      if (family && thread.familyActive) {
        await notifyUser(family, '💬 The nanny has closed the chat.');
      }
    }
    return { text: M.NANNY_MAIN_MENU, state: 'NANNY_MAIN_MENU', activeChat: null };
  }

  const thread = await ChatThread.findById(ctx.session.activeChat);
  if (!thread) return { text: M.NANNY_MAIN_MENU, state: 'NANNY_MAIN_MENU' };

  const nanny = await User.findById(ctx.session.user);
  thread.messages.push({ from: 'nanny', sender: nanny?._id, body: text, mediaUrl: ctx.mediaUrl });
  thread.lastMessageAt = new Date();
  await thread.save();

  const family = await User.findById(thread.family);
  if (family) {
    await notifyUser(family, `👩 ${nanny?.fullName || 'Nanny'}:\n${text}`);
  }
  return null;
};
nannyChatHandler.allowCommands = true;
on('NANNY_CHATTING', nannyChatHandler);

/* ------------------------------------------------------------------ *
 * My Bookings (nanny side)
 * ------------------------------------------------------------------ */

on('NB_BOOKINGS_MENU', async (ctx) => {
  const choice = parseChoice(ctx.text, 4);
  if (!choice) return NANNY_BOOKINGS_MENU;

  const statuses = [BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING,
    BOOKING_STATUS.COMPLETED, BOOKING_STATUS.CANCELLED];
  const status = statuses[choice - 1];

  const bookings = await Booking.find({ nanny: ctx.session.user, status }).sort({ startDate: 1 });
  if (!bookings.length) {
    return `You have no ${status} bookings.\n\nType *Back* for My Bookings, or *0* for the Main Menu.`;
  }

  const rows = await Promise.all(bookings.map(async (b, i) => {
    const family = await User.findById(b.family).select('fullName');
    const dateLine = b.isMultiDay
      ? `📅  ${prettyDate(b.startDate)} – ${prettyDate(b.endDate)} (${(b.serviceDays || []).length} days)`
      : `📅  ${prettyDate(b.startDate)}`;
    return `*${i + 1}. Booking ID #${b.bookingNumber}*\n\n👨‍👩‍👧  ${family?.fullName || 'Family'}\n${dateLine}\n⏰  ${timeRange(b.startTime, b.hoursPerDay)}\n💰  ${money(b.totalAmount)}\nStatus: ${statusLabel(b)}`;
  }));

  return {
    text: `You have *${bookings.length} ${status} booking${bookings.length > 1 ? 's' : ''}*.\nReply with a number to view details.\n\n${rows.join('\n\n')}`,
    state: 'NB_BOOKING_LIST',
    listing: { kind: 'nanny_bookings', ids: bookings.map((b) => String(b._id)), page: 0, pageSize: 50 },
  };
});

on('NB_BOOKING_LIST', async (ctx) => {
  const ids = ctx.session.listing?.ids || [];
  const n = parseChoice(ctx.text, ids.length);
  if (!n) return M.INVALID_CHOICE;

  const booking = await Booking.findById(ids[n - 1]);
  if (!booking) return M.INVALID_CHOICE;

  ctx.set('activeBookingId', String(booking._id));
  const family = await User.findById(booking.family);
  const menu = nannyBookingActionMenu(booking);

  return [
    { text: nannyBookingDetail(booking, family) },
    { text: menu.text, state: menu.state },
  ];
});

export function nannyBookingDetail(booking, family) {
  const dateLine = booking.isMultiDay
    ? `📅 ${prettyDate(booking.startDate)} – ${prettyDate(booking.endDate)} (${(booking.serviceDays || []).length} days)`
    : `📅 ${prettyDate(booking.startDate)}`;
  const lines = [
    `*Booking ID# ${booking.bookingNumber}*`, '',
    dateLine,
    `🕘 ${timeRange(booking.startTime, booking.hoursPerDay)}`,
  ];
  if (booking.isMultiDay && booking.repeatDays?.length) {
    lines.push(`🔄 Repeat on ${booking.repeatDays.join(', ')}`);
  }
  if (booking.address?.mapUrl) lines.push(`📍 ${booking.address.mapUrl}`);
  if (booking.address?.addressLine) lines.push(`🏡 ${booking.address.addressLine}`);
  lines.push('', `👨‍👩‍👧 ${family?.fullName || 'Family'}`);
  if (booking.requirements?.skills?.length) lines.push(`🛠 Skills: ${booking.requirements.skills.join(', ')}`);
  if (booking.children?.length) {
    const { childLines } = { childLines: null };
    lines.push('', `*Total Children:* ${booking.children.length}`);
    booking.children.forEach((c, i) => {
      const icon = i % 2 === 0 ? '👧' : '👦';
      lines.push('', `${icon} ${c.name} — ${c.age}`);
      lines.push(` • ${c.medicalNotes || 'No allergies'}`);
      lines.push(` • ${c.dietaryNotes || 'No dietary restrictions'}`);
    });
  }
  if (booking.otherInstructions) lines.push('', `*Other Instructions:*\n ${booking.otherInstructions}`);
  lines.push('', '*💰 Your Earnings*', `Rate: ${money(booking.hourlyRate)}/hr`, `Total: *${money(booking.totalAmount)}*`);
  lines.push('', `Status: ${statusLabel(booking)}`);
  return lines.join('\n');
}

export function nannyBookingActionMenu(booking) {
  const opts = [];
  if (booking.status === BOOKING_STATUS.ONGOING) {
    const sub = booking.subStatus;
    if (sub === BOOKING_SUBSTATUS.AWAITING_ARRIVAL) opts.push('Confirm My Arrival (enter code)');
    if (sub === BOOKING_SUBSTATUS.ARRIVAL_CONFIRMED || sub === BOOKING_SUBSTATUS.AWAITING_END_OF_SERVICE) {
      opts.push('Confirm End of Service (enter code)');
    }
    opts.push('Message Family');
    opts.push(booking.liveLocation?.nannySharing ? 'Stop Sharing Live Location' : 'Share My Live Location');
    opts.push('Report an Issue', 'Request Cancellation');
    return { text: menuText(opts), state: 'NB_ACTION_ONGOING' };
  }
  if (booking.status === BOOKING_STATUS.UPCOMING) {
    opts.push('Message Family', 'View Family Details', 'Report an Issue', 'Request Cancellation');
    return { text: menuText(opts), state: 'NB_ACTION_UPCOMING' };
  }
  if (booking.status === BOOKING_STATUS.COMPLETED) {
    opts.push('View Payment Details', 'Message Family');
    return { text: menuText(opts), state: 'NB_ACTION_COMPLETED' };
  }
  return {
    text: 'This booking is closed.\n\nType *Back* to go back to My Bookings, or *0* for the Main Menu.',
    state: 'NB_ACTION_CLOSED',
  };
}

function menuText(options) {
  return `What would you like to do?\n\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n\nType *BACK* to go back to My Bookings`;
}

function makeNannyActionHandler(state) {
  const handler = async (ctx) => {
    const booking = await Booking.findById(ctx.get('activeBookingId'));
    if (!booking) return { text: NANNY_BOOKINGS_MENU, state: 'NB_BOOKINGS_MENU' };

    const menu = nannyBookingActionMenu(booking);
    const labels = menu.text.split('\n')
      .map((l) => l.match(/^\d+\.\s+(.*)$/)).filter(Boolean).map((m) => m[1].trim());
    const choice = parseChoice(ctx.text, labels.length);
    if (!choice) return menu.text;

    return dispatchNannyAction(ctx, booking, labels[choice - 1]);
  };
  handler.prompt = async (ctx) => {
    const booking = await Booking.findById(ctx.get('activeBookingId'));
    return booking ? nannyBookingActionMenu(booking).text : NANNY_BOOKINGS_MENU;
  };
  on(state, handler);
}

['NB_ACTION_ONGOING', 'NB_ACTION_UPCOMING', 'NB_ACTION_COMPLETED', 'NB_ACTION_CLOSED']
  .forEach(makeNannyActionHandler);

async function dispatchNannyAction(ctx, booking, label) {
  switch (label) {
    case 'Confirm My Arrival (enter code)':
      return { text: `🔐 Please enter the *ARRIVAL code* the family gave you.`, state: 'NB_ENTER_ARRIVAL_CODE' };
    case 'Confirm End of Service (enter code)':
      return { text: `🔐 Please enter the *END-OF-SERVICE code* the family gave you.`, state: 'NB_ENTER_END_CODE' };
    case 'Message Family': {
      const family = await User.findById(booking.family);
      return openNannyChat(ctx, family, booking);
    }
    case 'View Family Details': {
      const family = await User.findById(booking.family);
      const menu = nannyBookingActionMenu(booking);
      return [{ text: nannyBookingDetail(booking, family) }, { text: menu.text, state: menu.state }];
    }
    case 'Share My Live Location':
      booking.liveLocation = { ...(booking.liveLocation || {}), nannySharing: true, updatedAt: new Date() };
      await booking.save();
      return {
        text: '📍 Please send your live location now.\n\nThe family will be able to see it. Type *STOP* to stop sharing.',
        state: 'NB_SHARING_LOCATION',
      };
    case 'Stop Sharing Live Location': {
      booking.liveLocation = { ...(booking.liveLocation || {}), nannySharing: false, updatedAt: new Date() };
      await booking.save();
      const menu = nannyBookingActionMenu(booking);
      return [{ text: '📍 You stopped sharing your live location.' }, { text: menu.text, state: menu.state }];
    }
    case 'Report an Issue':
      return { text: `🆘 Please describe the issue.`, state: 'NB_REPORT_ISSUE' };
    case 'Request Cancellation':
      return startNannyCancellation(ctx, booking);
    case 'View Payment Details':
      return showBookingPayment(ctx, booking);
    default:
      return M.INVALID_CHOICE;
  }
}

/* ------------------------------------------------------------------ *
 * Arrival / end-of-service confirmation
 * ------------------------------------------------------------------ */

on('NB_ENTER_ARRIVAL_CODE', async (ctx) => {
  const code = parseServiceCode(ctx.text);
  if (!code) return '❌ That code doesn\'t look right. It should look like *A123*.';

  const booking = await Booking.findById(ctx.get('activeBookingId'));
  if (!booking) return { text: NANNY_BOOKINGS_MENU, state: 'NB_BOOKINGS_MENU' };

  const day = booking.currentDay();
  if (!day) return 'There is no service scheduled right now.';
  if (day.arrivalOtp !== code) return '❌ That code is incorrect. Please ask the family for the ARRIVAL code.';

  day.status = SERVICE_DAY_STATUS.ARRIVAL_CONFIRMED;
  day.arrivalConfirmedAt = new Date();
  booking.markModified('serviceDays');
  syncBookingStatus(booking);
  await booking.save();

  const family = await User.findById(booking.family);
  const nanny = await User.findById(ctx.session.user);
  await notifyUser(family, `✅ *Nanny Arrival Confirmed*

${nanny?.fullName || 'Your nanny'} has arrived and her service has started.

📅 ${prettyDate(day.date)}
⏰ ${timeRange(booking.startTime, booking.hoursPerDay)}`);

  const menu = nannyBookingActionMenu(booking);
  return [
    { text: `✅ Your arrival has been confirmed. Have a great session!` },
    { text: menu.text, state: menu.state },
  ];
});

on('NB_ENTER_END_CODE', async (ctx) => {
  const code = parseServiceCode(ctx.text);
  if (!code) return '❌ That code doesn\'t look right. It should look like *A123*.';

  const booking = await Booking.findById(ctx.get('activeBookingId'));
  if (!booking) return { text: NANNY_BOOKINGS_MENU, state: 'NB_BOOKINGS_MENU' };

  const day = booking.currentDay();
  if (!day) return 'There is no service in progress right now.';
  if (day.endOtp !== code) return '❌ That code is incorrect. Please ask the family for the END-OF-SERVICE code.';

  return completeServiceDay(ctx, booking, day);
});

/** Close out a service day: overtime, payout, and next-day / completion state. */
export async function completeServiceDay(ctx, booking, day) {
  const now = new Date();
  day.status = SERVICE_DAY_STATUS.COMPLETED;
  day.endConfirmedAt = now;

  // Overtime: anything past the scheduled end, rounded per the spec.
  const extraMinutes = Math.max(0, Math.round((now - new Date(day.endAt)) / 60000));
  if (extraMinutes >= 15) {
    const hours = computeOvertimeHours(extraMinutes);
    day.overtimeMinutes = extraMinutes;
    day.overtimeHours = hours;
    day.overtimeAmount = round2(hours * (booking.hourlyRate || 0));
  }

  booking.markModified('serviceDays');
  syncBookingStatus(booking);
  await booking.save();

  const remaining = booking.serviceDays.filter(
    (d) => d.status !== SERVICE_DAY_STATUS.COMPLETED && d.status !== SERVICE_DAY_STATUS.CANCELLED
  );
  const isFinal = remaining.length === 0;

  await queuePayout(booking, {
    nannyId: booking.nanny,
    amount: dayEarnings(booking, day),
    serviceDayIds: [day._id],
    isFinal,
    notes: `Service on ${day.date}`,
  });

  const family = await User.findById(booking.family);
  const nanny = await User.findById(booking.nanny);

  if (isFinal) {
    await notifyUser(family, `🎉 *Booking Completed*

Booking #${booking.bookingNumber} is now complete.

Thank you for using My Nanny! ❤️

Would you like to rate ${nanny?.fullName || 'your nanny'}? Go to *My Bookings > Completed*.`);
  } else {
    await notifyUser(family, `✅ Today's service for *${prettyDate(day.date)}* has been successfully completed.

*Remaining service days: ${remaining.length}*
Your overall Booking *#${booking.bookingNumber}* is still Ongoing

Thank you for using My Nanny! ❤️`);
  }

  const overtimeNote = day.overtimeAmount > 0
    ? `\n⏰ Overtime: ${day.overtimeHours} hr (+${money(day.overtimeAmount)})`
    : '';

  return {
    text: `✅ *Service Completed*

${prettyDate(day.date)} — ${timeRange(booking.startTime, booking.hoursPerDay)}${overtimeNote}

💰 Earnings for today: *${money(dayEarnings(booking, day))}*
Payment will be released on the next payout Monday.

${isFinal ? '🎉 This booking is now fully complete!' : `📅 Remaining service days: *${remaining.length}*`}

Type *0* to return to the Main Menu.`,
    state: 'NANNY_MAIN_MENU',
  };
}

on('NB_SHARING_LOCATION', async (ctx) => {
  const booking = await Booking.findById(ctx.get('activeBookingId'));
  if (!booking) return { text: NANNY_BOOKINGS_MENU, state: 'NB_BOOKINGS_MENU' };

  if (lower(ctx.text) === 'stop') {
    booking.liveLocation = { ...(booking.liveLocation || {}), nannySharing: false, updatedAt: new Date() };
    await booking.save();
    const menu = nannyBookingActionMenu(booking);
    return [{ text: '📍 You stopped sharing your live location.' }, { text: menu.text, state: menu.state }];
  }

  const loc = clean(ctx.text) || ctx.mediaUrl;
  if (!loc) return '📍 Please send your location, or type *STOP* to stop sharing.';

  booking.liveLocation = {
    ...(booking.liveLocation || {}),
    nannySharing: true, lastNannyLocation: loc, updatedAt: new Date(),
  };
  await booking.save();

  const family = await User.findById(booking.family);
  const nanny = await User.findById(ctx.session.user);
  await notifyUser(family, `📍 *${nanny?.fullName || 'Your nanny'}'s live location*\n${loc}`);

  return '📍 Location shared with the family. Send another to update it, or type *STOP*.';
});

on('NB_REPORT_ISSUE', async (ctx) => {
  const description = clean(ctx.text);
  if (description.length < 5) return '🆘 Please describe the issue.';

  const booking = await Booking.findById(ctx.get('activeBookingId'));
  const ticketNumber = `T-${await nextSequence('ticket', 1000)}`;
  await Ticket.create({
    ticketNumber,
    raisedBy: ctx.session.user,
    raisedByRole: 'nanny',
    booking: booking?._id,
    category: TICKET_CATEGORY.BOOKING,
    subject: booking ? `Issue with Booking #${booking.bookingNumber}` : 'Support request',
    description,
  });
  return {
    text: `✅ Your ticket *${ticketNumber}* has been created.\n\nOur support team will contact you shortly.\n\nType *0* to return to the Main Menu.`,
    state: 'NANNY_MAIN_MENU',
  };
});

/* ------------------------------------------------------------------ *
 * Nanny cancellation request
 * ------------------------------------------------------------------ */

async function startNannyCancellation(ctx, booking) {
  return {
    text: `⚠️ *Request Cancellation*

Booking ID# ${booking.bookingNumber}

Cancelling an accepted booking affects the family and your rating. The family will receive a *100% refund* for all remaining services, and you will not be compensated for them.

Please tell us why you need to cancel.

Type your reason, or type *Back* to keep the booking.`,
    state: 'NB_CANCEL_REASON',
  };
}

on('NB_CANCEL_REASON', async (ctx) => {
  const reason = clean(ctx.text);
  if (reason.length < 3) return 'Please tell us why you need to cancel, or type *Back* to keep the booking.';

  const booking = await Booking.findById(ctx.get('activeBookingId'));
  if (!booking) return { text: NANNY_BOOKINGS_MENU, state: 'NB_BOOKINGS_MENU' };

  ctx.set('cancelReason', reason);
  const preview = computeCancellationRefund(booking, { cancelledBy: CANCELLED_BY.NANNY });

  return {
    text: `Are you sure you want to cancel Booking #${booking.bookingNumber}?

💰 Family refund: *${money(preview.totalRefund)}*
👩 Your compensation for remaining days: *${money(0)}*
${preview.completedAmount > 0 ? `✅ You keep earnings for completed services: *${money(preview.completedAmount)}*` : ''}

1. Yes, cancel the booking
2. No, keep the booking`,
    state: 'NB_CANCEL_CONFIRM',
  };
});

on('NB_CANCEL_CONFIRM', async (ctx) => {
  const choice = parseChoice(ctx.text, 2);
  if (!choice) return M.INVALID_CHOICE;

  const booking = await Booking.findById(ctx.get('activeBookingId'));
  if (!booking) return { text: NANNY_BOOKINGS_MENU, state: 'NB_BOOKINGS_MENU' };

  if (choice === 2) {
    const menu = nannyBookingActionMenu(booking);
    return [{ text: 'Your booking has been kept.' }, { text: menu.text, state: menu.state }];
  }

  const nanny = await User.findById(ctx.session.user);
  const reason = ctx.get('cancelReason', 'Nanny cancelled');

  // Spec: the booking enters replacement-needed rather than being cancelled.
  await markNannyCancelled(booking, { reason });

  const family = await User.findById(booking.family);
  const replacements = await findReplacements(booking);

  if (replacements.length) {
    const { Session } = await import('../models/index.js');
    const session = await Session.findOne({ phone: family.phone });
    if (session) {
      session.state = 'FB_REPLACEMENT_LISTING';
      session.data = { ...(session.data || {}), activeBookingId: String(booking._id) };
      session.listing = { kind: 'replacements', ids: replacements.map((n) => String(n._id)), page: 0, pageSize: 3 };
      session.markModified('data');
      await session.save();
    }
    await notifyUser(family, `🔴 *Your nanny has cancelled*

${nanny?.fullName || 'Your nanny'} has cancelled Booking #${booking.bookingNumber}.

Don't worry — here are available replacement nannies:

${M.nannyListing(replacements.slice(0, 3), { startIndex: 0, total: replacements.length })}

Or type *0* and go to My Bookings to cancel for a full refund.`);
  } else {
    await notifyUser(family, `🔴 *Your nanny has cancelled*

${nanny?.fullName || 'Your nanny'} has cancelled Booking #${booking.bookingNumber}.

We couldn't find a replacement immediately — our team is working on it. You can also cancel for a full refund of all unused services from *My Bookings*.`);
  }

  return {
    text: `Your cancellation has been recorded for Booking #${booking.bookingNumber}.

The family has been notified and offered a replacement.

⚠️ Frequent cancellations may affect your rating and visibility to families.

Type *0* to return to the Main Menu.`,
    state: 'NANNY_MAIN_MENU',
  };
});

async function showBookingPayment(ctx, booking) {
  const payouts = await Payout.find({ booking: booking._id, nanny: ctx.session.user });
  const total = payouts.reduce((s, p) => s + (p.amount || 0), 0);
  const menu = nannyBookingActionMenu(booking);
  const rows = payouts.map((p) => `• ${money(p.amount)} — ${p.status.replace(/_/g, ' ')}${p.releasedAt ? ` (${prettyDate(p.releasedAt)})` : ''}`);
  return [
    {
      text: `💰 *Payment details — Booking #${booking.bookingNumber}*

Rate: ${money(booking.hourlyRate)}/hr
Service days completed: ${booking.completedDays().length}

${rows.join('\n') || 'No payouts recorded yet.'}

*Total: ${money(total)}*`,
    },
    { text: menu.text, state: menu.state },
  ];
}

async function showNannyReferral(ctx) {
  const user = await User.findById(ctx.session.user);
  if (!user.referralCode) {
    const { makeReferralCode } = await import('./common.js');
    user.referralCode = makeReferralCode(user.fullName);
    await user.save();
  }

  const link = `${config.referral.linkBase || config.publicBaseUrl}/r/${user.referralCode}`;

  return {
    text: `\u{1F381} *Refer a Friend*

Invite other nannies to join My Nanny and earn rewards when they complete their first booking.

Your link: ${link}

Type *0* to return to the Main Menu.`,
    state: 'NANNY_MAIN_MENU',
  };
}


export default {
  NANNY_BOOKINGS_MENU, NANNY_AVAILABILITY_MENU, NANNY_PROFILE_MENU,
  NANNY_PAYMENTS_MENU, NANNY_SUPPORT_MENU, completeServiceDay,
  notifyFamilyOfDecline, openNannyChat,
};
