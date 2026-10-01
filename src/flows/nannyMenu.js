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
import {
  queuePayout, refundBooking, dayWorkers, recordOvertime, takeOvertimeCommission, nannyBookingPay,
  rateForDay,
} from '../services/payments.js';
import { findReplacements } from '../services/matching.js';
import { notifyUser } from '../services/notify.js';
import { applyPendingChange } from './familyBookingActions.js';
import {
  statusLabel, prettyDate, timeRange, money, nannyDisplayName, firstName,
} from '../utils/format.js';
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
  const choice = parseChoice(ctx.text, 8);
  if (!choice) return M.NANNY_MAIN_MENU;

  const user = await User.findById(ctx.session.user);
  if (user && user.nannyStatus !== NANNY_STATUS.VERIFIED) {
    return `⏳ Your profile is still under review. You'll be able to use this menu once you're approved.`;
  }

  switch (choice) {
    case 1: return showPendingRequests(ctx);
    case 2: return { text: NANNY_BOOKINGS_MENU, state: 'NB_BOOKINGS_MENU' };
    case 3: return showNannyThreads(ctx);
    case 4: return { text: NANNY_AVAILABILITY_MENU, state: 'NA_MENU' };
    case 5: return { text: NANNY_PROFILE_MENU, state: 'NP_MENU' };
    case 6: return { text: NANNY_PAYMENTS_MENU, state: 'NPAY_MENU' };
    case 7: return showNannyReferral(ctx);
    case 8: return { text: NANNY_SUPPORT_MENU, state: 'NSUP_MENU' };
    default: return M.NANNY_MAIN_MENU;
  }
};
nannyMenuHandler.prompt = () => M.NANNY_MAIN_MENU;
on('NANNY_MAIN_MENU', nannyMenuHandler);

/* ------------------------------------------------------------------ *
 * Booking requests (accept / decline within the response window)
 * ------------------------------------------------------------------ */

/**
 * The response row belonging to *this* nanny.
 *
 * A 24h booking opens a window for two nannies, so `nannyResponses` can hold
 * more than one pending row. Taking the first meant the second nanny opening
 * her request loaded and acted on the first nanny's row — accepting on her
 * behalf, or declining a booking the other had already taken.
 *
 * `nannyResponse.js` (the phone-app path) has always filtered by id. This is
 * the same predicate, for the WhatsApp path.
 */
function pendingFor(booking, nannyId) {
  return (booking.nannyResponses || []).find(
    (r) => String(r.nanny) === String(nannyId) && r.outcome === 'pending',
  );
}

async function showPendingRequests(ctx) {
  // Either seat: the second nanny on a 24h booking has requests too, and
  // could only answer one if her very next message happened to be 1 or 2.
  const bookings = await Booking.find({
    $or: [{ nanny: ctx.session.user }, { secondNanny: ctx.session.user }],
    'nannyResponses.outcome': 'pending',
    status: {
      $in: [BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING, BOOKING_STATUS.PENDING_ADDITIONAL_PAYMENT],
    },
  });

  const live = bookings.filter((b) => {
    const p = pendingFor(b, ctx.session.user);
    return p && new Date(p.expiresAt) > new Date();
  });

  if (!live.length) {
    return `📭 You have no pending booking requests right now.\n\nWe'll message you as soon as a family books you.\n\nType *0* to return to the Main Menu.`;
  }

  if (live.length === 1) {
    const b = live[0];
    const family = await User.findById(b.family);
    const p = pendingFor(b, ctx.session.user);
    ctx.set('requestBookingId', String(b._id));
    return {
      text: M.nannyBookingRequest(b, family, p.expiresAt, { isChange: p.kind === 'booking_change', nannyId: ctx.session.user }),
      state: 'NANNY_BOOKING_REQUEST',
    };
  }

  const rows = await Promise.all(live.map(async (b, i) => {
    const family = await User.findById(b.family).select('fullName');
    return `*${i + 1}. Booking ID #${b.bookingNumber}*\n👨‍👩‍👧 ${family?.fullName || 'Family'}\n📅 ${prettyDate(b.startDate)}\n⏰ ${timeRange(b.startTime, b.hoursPerDay)}\n💰 ${money(nannyBookingPay(b, ctx.session.user).total)}`;
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
  const p = pendingFor(booking, ctx.session.user);
  ctx.set('requestBookingId', String(booking._id));

  return {
    text: M.nannyBookingRequest(booking, family, p?.expiresAt, { isChange: p?.kind === 'booking_change', nannyId: ctx.session.user }),
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

  const pending = pendingFor(booking, ctx.session.user);
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
  const p = pendingFor(booking, ctx.session.user);
  return M.nannyBookingRequest(booking, family, p?.expiresAt, { isChange: p?.kind === 'booking_change', nannyId: ctx.session.user });
};
on('NANNY_BOOKING_REQUEST', requestHandler);

async function acceptRequest(ctx, booking, pending) {
  const nanny = await User.findById(ctx.session.user);

  // The same check the app makes: still open, and she is still free.
  const { acceptBlocker } = await import('../services/booking.js');
  const blocker = await acceptBlocker(booking, nanny, pending);
  if (blocker === 'closed') {
    pending.outcome = 'declined';
    pending.declineReason = 'Booking no longer active';
    await booking.save();
    return { text: `Booking #${booking.bookingNumber} is no longer active, so there is nothing to accept.\n\nType *0* to return to the Main Menu.`, state: 'NANNY_MAIN_MENU' };
  }
  if (blocker === 'busy') {
    return { text: `You already have another booking at that time, so you cannot accept Booking #${booking.bookingNumber}.\n\nPlease decline it so the family can choose someone else.\n\n1. Accept\n2. Decline` };
  }

  pending.outcome = 'accepted';
  pending.respondedAt = new Date();

  const isChange = pending.kind === 'booking_change';
  const family = await User.findById(booking.family);

  const { changeStillAwaited } = await import('../services/booking.js');
  if (isChange && changeStillAwaited(booking, pending)) {
    // The other nanny on this 24h booking has not answered yet; the change
    // waits for her.
    await booking.save();
  } else if (isChange) {
    await applyPendingChange(booking);
    await notifyUser(family, `✅ *Booking Updated*

${nannyDisplayName(nanny)} has accepted your changes to Booking #${booking.bookingNumber}.

${M.bookingSummary(booking, { showId: true, nanny, paid: true, showStatus: true })}`);
  } else {
    booking.subStatus = BOOKING_SUBSTATUS.NANNY_CONFIRMED;
    // A top-up still owed keeps the booking asking for it; accepting the job
    // does not pay it.
    const owesTopUp = booking.status === BOOKING_STATUS.PENDING_ADDITIONAL_PAYMENT
      && (booking.additionalDue || 0) > 0;
    if (booking.status !== BOOKING_STATUS.ONGOING && !owesTopUp) booking.status = BOOKING_STATUS.UPCOMING;
    await booking.save();
    await notifyUser(family, `🎉 *Booking Confirmed!*

${nannyDisplayName(nanny)} has accepted your booking.

${M.bookingSummary(booking, { showId: true, nanny, paid: true, showStatus: true })}`);
  }

  return {
    text: `✅ *Booking Accepted*

Booking ID# ${booking.bookingNumber}
📅 ${prettyDate(booking.startDate)}${booking.isMultiDay ? ` – ${prettyDate(booking.endDate)}` : ''}
⏰ ${timeRange(booking.startTime, booking.hoursPerDay)}
💰 ${money(nannyBookingPay(booking, ctx.session.user).total)}

The family has been notified. You'll get a reminder before the service starts.

Type *0* to return to the Main Menu.`,
    state: 'NANNY_MAIN_MENU',
  };
}

on('NANNY_DECLINE_REASON', async (ctx) => {
  const booking = await Booking.findById(ctx.get('requestBookingId'));
  if (!booking) return { text: M.NANNY_MAIN_MENU, state: 'NANNY_MAIN_MENU' };

  const pending = pendingFor(booking, ctx.session.user);
  if (!pending) return { text: M.NANNY_MAIN_MENU, state: 'NANNY_MAIN_MENU' };

  const reason = ctx.command === 'SKIP' ? 'No reason given' : clean(ctx.text);
  pending.outcome = 'declined';
  pending.respondedAt = new Date();
  pending.declineReason = reason;

  const isChange = pending.kind === 'booking_change';
  // Whoever is declining, not whoever the booking lists first — on a 24h
  // booking those are different people, and blacklisting the wrong one takes
  // a nanny off a job she had already accepted.
  const nannyId = pending.nanny || booking.nanny;

  if (isChange) {
    // Spec: the original booking stands; the family may now pick someone else.
    booking.pendingChange = undefined;
    // Only claim a confirmed nanny if there still is one. She may have
    // cancelled the booking outright while this change request was open,
    // which clears `nanny` and moves the booking to awaiting-replacement.
    // Overwriting that leaves a booking claiming a nanny it does not have:
    // the family loses the replacement menu and the auto-cancel sweep
    // stops seeing it, so it strands with no nanny and no refund.
    if (booking.nanny) booking.subStatus = BOOKING_SUBSTATUS.NANNY_CONFIRMED;
    await booking.save();
  } else {
    if (nannyId && !booking.rejectedNannies.some((id) => String(id) === String(nannyId))) {
      booking.rejectedNannies.push(nannyId);
    }
    // Her seat, not the first one: on a 24h booking she may be the second nanny.
    const { removeNannyFromBooking } = await import('../services/booking.js');
    if (!removeNannyFromBooking(booking, nannyId)) booking.nanny = undefined;
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

/**
 * Her conversations, so a family can write to her before any booking exists.
 *
 * Every other way into a chat needs a live booking, so a pre-booking enquiry
 * reached her as a notification she could not answer — the family's screen
 * invited her to reply and there was nowhere for the reply to go.
 */
export async function showNannyThreads(ctx) {
  const threads = await ChatThread.find({ nanny: ctx.session.user, closed: false })
    .populate('family', 'fullName')
    .sort({ lastMessageAt: -1 })
    .limit(10);

  if (!threads.length) {
    return 'You have no messages yet.\n\nWhen a family writes to you it will appear here.\n\nType *0* for the Main Menu.';
  }

  const rows = threads.map((t, i) => {
    const last = t.messages[t.messages.length - 1];
    const who = firstName(t.family?.fullName) || 'A family';
    const preview = last?.body ? `\n   _${last.body.slice(0, 60)}_` : '';
    return `${i + 1}. 👨‍👩‍👧 ${who}${preview}`;
  });

  return {
    text: `💬 *Messages*\n\n${rows.join('\n\n')}\n\nReply with a number to open a conversation.\nType *0* for the Main Menu.`,
    state: 'NANNY_THREADS',
    data: { threadIds: threads.map((t) => String(t._id)) },
  };
}

on('NANNY_THREADS', async (ctx) => {
  const ids = ctx.get('threadIds') || [];
  const choice = parseChoice(ctx.text, ids.length);
  if (!choice) return showNannyThreads(ctx);

  const thread = await ChatThread.findById(ids[choice - 1]);
  if (!thread) return showNannyThreads(ctx);

  const family = await User.findById(thread.family);
  if (!family) return showNannyThreads(ctx);

  return openNannyChat(ctx, family, thread.booking ? { _id: thread.booking } : null);
});

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

  /**
   * What was already said, so she is not answering a question she cannot see.
   *
   * The messages were always stored and never shown: opening a chat gave her a
   * blank screen, even when the family had asked something several lines long.
   */
  const recent = (thread.messages || []).slice(-6)
    .map((m) => (m.from === 'family'
      ? `👨‍👩‍👧 ${m.body || '(photo)'}`
      : `🙋 ${m.body || '(photo)'}`))
    .join('\n');

  const history = recent ? `\n\n*Earlier*\n${recent}` : '';

  return {
    text: `You can now chat with ${firstName(family.fullName) || 'the family'}.\nYour phone numbers remain private.\nType "*Bye*" at any time to close the chat.${history}`,
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

  // Same in this direction: a nanny cannot pass her number out either.
  const { redactContactDetails, CONTACT_BLOCKED_NOTICE } =
    await import('../utils/contactFilter.js');
  const safe = redactContactDetails(text);

  // A photo is copied to our own server first: WhatsApp's links expire, and the
  // copy is what the other side is sent and what the office can look at later.
  let photo = null;
  if (ctx.mediaUrl) {
    const { store } = await import('../services/mediaArchive.js');
    photo = await store(ctx.mediaUrl, { mediaType: ctx.mediaType }).catch(() => ctx.mediaUrl);
  }

  const nanny = await User.findById(ctx.session.user);
  thread.messages.push({ from: 'nanny', sender: nanny?._id, body: safe.text, mediaUrl: photo || undefined });
  thread.lastMessageAt = new Date();
  await thread.save();

  const family = await User.findById(thread.family);
  let delivered = { live: false, sent: false };
  if (family) {
    const { relayChatMessage } = await import('../services/notify.js');
    delivered = await relayChatMessage(family, `👩 ${nannyDisplayName(nanny)}:\n${safe.text}`, {
      threadId: thread._id,
      mediaUrl: photo,
    });
  }

  // She was told nothing when her message was cut, unlike the family, who got
  // the notice. Same message both ways now.
  if (safe.redacted) return CONTACT_BLOCKED_NOTICE;

  if (delivered.skipped || delivered.sent === false) {
    return '⚠️ That did not reach them. It is saved — please try again in a moment.';
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

  // A booking waiting on a family top-up is listed under upcoming or ongoing,
  // wherever its days stand; otherwise she could not reach it to check in.
  const live = status === BOOKING_STATUS.UPCOMING || status === BOOKING_STATUS.ONGOING;
  const found = await Booking.find({
    $or: [{ nanny: ctx.session.user }, { secondNanny: ctx.session.user }],
    status: live ? { $in: [status, BOOKING_STATUS.PENDING_ADDITIONAL_PAYMENT] } : status,
  }).sort({ startDate: 1 });
  const bookings = found.filter((b) => nannyStatus(b) === status);
  if (!bookings.length) {
    return `You have no ${status} bookings.\n\nType *Back* for My Bookings, or *0* for the Main Menu.`;
  }

  const rows = await Promise.all(bookings.map(async (b, i) => {
    const family = await User.findById(b.family).select('fullName');
    const dateLine = b.isMultiDay
      ? `📅  ${prettyDate(b.startDate)} – ${prettyDate(b.endDate)} (${(b.serviceDays || []).length} days)`
      : `📅  ${prettyDate(b.startDate)}`;
    return `*${i + 1}. Booking ID #${b.bookingNumber}*\n\n👨‍👩‍👧  ${family?.fullName || 'Family'}\n${dateLine}\n⏰  ${timeRange(b.startTime, b.hoursPerDay)}\n💰  ${money(nannyBookingPay(b, ctx.session.user).total)}\nStatus: ${statusLabel(b)}`;
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
    { text: nannyBookingDetail(booking, family, ctx.session.user) },
    { text: menu.text, state: menu.state },
  ];
});

export function nannyBookingDetail(booking, family, nannyId = null) {
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
  const pay = nannyBookingPay(booking, nannyId || booking.nanny);
  lines.push('', '*💰 Your Earnings*', `Rate: ${money(pay.rate)}/hr`, `Total: *${money(pay.total)}*`);
  lines.push('', `Status: ${statusLabel(booking)}`);
  return lines.join('\n');
}

/**
 * The status a nanny should see a booking as.
 *
 * A booking waiting on a family top-up is still a job she is working: its days
 * run and she has to check in and out of them. The top-up is between us and
 * the family, so to her it reads as upcoming or ongoing like any other.
 */
export function nannyStatus(booking) {
  if (booking.status !== BOOKING_STATUS.PENDING_ADDITIONAL_PAYMENT) return booking.status;
  const started = (booking.serviceDays || []).some((d) => ![
    SERVICE_DAY_STATUS.SCHEDULED, SERVICE_DAY_STATUS.CANCELLED,
  ].includes(d.status));
  return started ? BOOKING_STATUS.ONGOING : BOOKING_STATUS.UPCOMING;
}

export function nannyBookingActionMenu(booking) {
  const opts = [];
  const status = nannyStatus(booking);
  if (status === BOOKING_STATUS.ONGOING) {
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
  if (status === BOOKING_STATUS.UPCOMING) {
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
      return [{ text: nannyBookingDetail(booking, family, ctx.session.user) }, { text: menu.text, state: menu.state }];
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

/** How many wrong codes a day allows before entry locks. */
const MAX_CODE_ATTEMPTS = 5;

/**
 * A wrong code was entered: count it, and lock and alert the office at five.
 * Returns the message to send her.
 */
async function wrongCode(ctx, booking, day, which) {
  day.codeAttempts = (day.codeAttempts || 0) + 1;
  booking.markModified('serviceDays');
  await booking.save();

  if (day.codeAttempts >= MAX_CODE_ATTEMPTS) {
    const ticketNumber = `T-${await nextSequence('ticket', 1000)}`;
    await Ticket.create({
      ticketNumber,
      raisedBy: ctx.session.user,
      raisedByRole: 'nanny',
      booking: booking._id,
      category: TICKET_CATEGORY.BOOKING,
      subject: `Code entry locked on Booking #${booking.bookingNumber}`,
      description: `${MAX_CODE_ATTEMPTS} wrong ${which} codes were entered for ${day.date}. `
        + 'Check with the family and the nanny before unlocking.',
    });
    return `🔒 Too many wrong codes. Code entry for this booking is locked and our team has been alerted (ticket ${ticketNumber}). They will contact you shortly.`;
  }
  const left = MAX_CODE_ATTEMPTS - day.codeAttempts;
  return `❌ That code is incorrect. Please ask the family for the ${which} code. (${left} ${left === 1 ? 'try' : 'tries'} left)`;
}

on('NB_ENTER_ARRIVAL_CODE', async (ctx) => {
  const code = parseServiceCode(ctx.text);
  if (!code) return '❌ That code doesn\'t look right. It is the 6-digit code the family received.';

  const booking = await Booking.findById(ctx.get('activeBookingId'));
  if (!booking) return { text: NANNY_BOOKINGS_MENU, state: 'NB_BOOKINGS_MENU' };

  const day = booking.currentDay();
  // Only a day actually waiting for her arrival — or about to start, so a
  // nanny who arrives a little early can still check in.
  const startsSoon = day?.status === SERVICE_DAY_STATUS.SCHEDULED
    && new Date(day.startAt) - Date.now() <= 2 * 3600e3;
  if (!day || (day.status !== SERVICE_DAY_STATUS.AWAITING_ARRIVAL && !startsSoon)) {
    return 'There is no service waiting for your arrival right now.';
  }
  if ((day.codeAttempts || 0) >= MAX_CODE_ATTEMPTS) return '🔒 Code entry for this booking is locked. Our team will contact you.';
  if (day.arrivalOtp !== code) return wrongCode(ctx, booking, day, 'ARRIVAL');
  day.codeAttempts = 0;

  day.status = SERVICE_DAY_STATUS.ARRIVAL_CONFIRMED;
  day.arrivalConfirmedAt = new Date();
  booking.markModified('serviceDays');
  syncBookingStatus(booking);
  await booking.save();

  const family = await User.findById(booking.family);
  const nanny = await User.findById(ctx.session.user);
  await notifyUser(family, `✅ *Nanny Arrival Confirmed*

${nannyDisplayName(nanny)} has arrived and her service has started.

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
  if (!code) return '❌ That code doesn\'t look right. It is the 6-digit code the family received.';

  const booking = await Booking.findById(ctx.get('activeBookingId'));
  if (!booking) return { text: NANNY_BOOKINGS_MENU, state: 'NB_BOOKINGS_MENU' };

  const day = booking.currentDay();
  // Only a day she has actually arrived for.
  if (!day || ![SERVICE_DAY_STATUS.ARRIVAL_CONFIRMED, SERVICE_DAY_STATUS.AWAITING_END_OF_SERVICE].includes(day.status)) {
    return 'There is no service in progress right now.';
  }
  if ((day.codeAttempts || 0) >= MAX_CODE_ATTEMPTS) return '🔒 Code entry for this booking is locked. Our team will contact you.';
  if (day.endOtp !== code) return wrongCode(ctx, booking, day, 'END-OF-SERVICE');
  day.codeAttempts = 0;

  return completeServiceDay(ctx, booking, day);
});

/** Close out a service day: overtime, payout, and next-day / completion state. */
export async function completeServiceDay(ctx, booking, day) {
  const now = new Date();
  day.status = SERVICE_DAY_STATUS.COMPLETED;
  day.endConfirmedAt = now;

  // Who worked it and at what rate, written now. Unstamped days were later
  // credited to whoever held the booking — a replacement got the credit for
  // days her predecessor had worked.
  if (!day.nanny && booking.nanny) day.nanny = booking.nanny;
  if (!day.nannyRate) day.nannyRate = rateForDay(booking, day, day.nanny) || undefined;

  // Whoever closes the day is the one who stayed on, so any overtime is hers.
  // On a 24h booking that can be either nanny; anyone else falls back to the
  // booking's own nanny rather than being paid for a booking she is not on.
  const onBooking = [day.nanny || booking.nanny, booking.secondNanny]
    .filter(Boolean).map(String);
  const closer = onBooking.includes(String(ctx.session.user))
    ? String(ctx.session.user)
    : onBooking[0];

  // Overtime: anything past the scheduled end, rounded per the spec. The
  // family pays it to her in person; our commission on it is taken off her
  // payout below.
  const extraMinutes = Math.max(0, Math.round((now - new Date(day.endAt)) / 60000));
  let overtimeHeld = false;
  if (extraMinutes >= 15) {
    const hours = computeOvertimeHours(extraMinutes);
    day.overtimeMinutes = extraMinutes;

    /**
     * Only a plausible overrun is charged automatically.
     *
     * Overtime is measured from when the end code is typed, and the family is
     * asked to pay it in cash on the spot. A code forgotten until the next
     * morning read as sixteen hours of overtime and a demand for over a
     * million rupiah. Anything past the limit is left for the office to
     * confirm rather than billed.
     */
    if (hours > config.maxAutoOvertimeHours) overtimeHeld = true;
    else if (hours > 0) recordOvertime(booking, day, closer, hours);
  }

  booking.markModified('serviceDays');
  syncBookingStatus(booking);
  await booking.save();

  const remaining = booking.serviceDays.filter(
    (d) => d.status !== SERVICE_DAY_STATUS.COMPLETED && d.status !== SERVICE_DAY_STATUS.CANCELLED
  );
  const isFinal = remaining.length === 0;

  /**
   * One payout per nanny who worked the day, each at her own rate.
   *
   * This used to queue a single payout to `booking.nanny`, whoever had closed
   * the day — so on a 24h booking the second nanny was told one figure while
   * a payout for a different figure was filed against the first nanny.
   *
   * The payout covers her scheduled hours only. Overtime was paid to her in
   * person by the family, so paying it again here would pay it twice; instead
   * our commission on it comes off, and the payout records both.
   */
  const settled = [];
  for (const w of dayWorkers(booking, day)) {
    if (!w.nannyId) continue;
    // eslint-disable-next-line no-await-in-loop
    const { taken, stillOwed } = await takeOvertimeCommission(w.nannyId, {
      add: w.commission,
      available: w.base,
    });
    const net = round2(w.base - taken);
    const hadOvertime = w.commission > 0;

    // eslint-disable-next-line no-await-in-loop
    await queuePayout(booking, {
      nannyId: w.nannyId,
      amount: net,
      serviceDayIds: [day._id],
      isFinal,
      notes: `Service on ${day.date}`,
      overtime: (hadOvertime || taken > 0) ? {
        hours: hadOvertime ? day.overtimeHours : 0,
        collectedByNanny: hadOvertime ? day.overtimeAmount : 0,
        nannyShare: w.overtimePay,
        commission: w.commission,
        grossPay: w.base,
        commissionDeducted: taken,
        stillOwed,
      } : null,
    });
    settled.push({ ...w, taken, net, stillOwed });
  }

  const family = await User.findById(booking.family);
  const nanny = await User.findById(booking.nanny);
  const closerDoc = closer && closer !== String(booking.nanny)
    ? await User.findById(closer)
    : nanny;

  // The family is asked for overtime here, at the door, because this is the
  // only moment they are told about it — nothing else ever invoices it.
  const familyOvertime = day.overtimeCollectedByNanny && day.overtimeAmount > 0
    ? `\n\n⏰ *Overtime:* ${day.overtimeHours} hr past the booked time.\nPlease pay *${money(day.overtimeAmount)}* directly to ${nannyDisplayName(closerDoc)}.`
    : '';

  if (isFinal) {
    await notifyUser(family, `🎉 *Booking Completed*

Booking #${booking.bookingNumber} is now complete.${familyOvertime}

Thank you for using My Nanny! ❤️

Would you like to rate ${nannyDisplayName(nanny)}? Go to *My Bookings > Completed*.`);
  } else {
    await notifyUser(family, `✅ Today's service for *${prettyDate(day.date)}* has been successfully completed.${familyOvertime}

*Remaining service days: ${remaining.length}*
Your overall Booking *#${booking.bookingNumber}* is still Ongoing

Thank you for using My Nanny! ❤️`);
  }

  // The other nanny on a 24h booking did not close the day, but she worked it
  // and is being paid for it, so she is told what was queued for her.
  for (const s of settled) {
    if (s.nannyId === closer) continue;
    // eslint-disable-next-line no-await-in-loop
    const other = await User.findById(s.nannyId);
    // eslint-disable-next-line no-await-in-loop
    if (other) await notifyUser(other, payoutNote(booking, day, s));
  }

  const mine = settled.find((s) => s.nannyId === closer) || settled[0];

  return {
    text: `✅ *Service Completed*

${prettyDate(day.date)} — ${timeRange(booking.startTime, booking.hoursPerDay)}

${mine ? payoutLines(day, mine) : ''}${overtimeHeld ? `\n⏰ The end code was entered ${Math.round(extraMinutes / 60)} hours after the booked end, so no overtime was charged. If you really worked that long, please contact support and the office will confirm it.\n` : ''}
Payment will be released on the next payout Monday.

${isFinal ? '🎉 This booking is now fully complete!' : `📅 Remaining service days: *${remaining.length}*`}

Type *0* to return to the Main Menu.`,
    state: 'NANNY_MAIN_MENU',
  };
}

/** What one nanny was paid for a day, including any overtime settlement. */
function payoutLines(day, s) {
  const lines = [`💰 Earnings for today: *${money(s.base)}*`];
  if (s.commission > 0) {
    lines.push(
      '',
      `⏰ Overtime: ${day.overtimeHours} hr`,
      `Please collect *${money(day.overtimeAmount)}* from the family in person.`,
      `Your share is ${money(s.overtimePay)}. The My Nanny commission of ${money(s.commission)} comes off your payout.`,
    );
  }
  if (s.taken > 0) {
    lines.push('', `🧾 Payout after commission: *${money(s.net)}*`);
    if (s.stillOwed > 0) lines.push(`Still to come off your next payout: ${money(s.stillOwed)}`);
  }
  return `${lines.join('\n')}\n`;
}

function payoutNote(booking, day, s) {
  return `✅ *Service Completed* — Booking #${booking.bookingNumber}

${prettyDate(day.date)}

${payoutLines(day, s)}
Payment will be released on the next payout Monday.`;
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
  await notifyUser(family, `📍 *${nannyDisplayName(nanny)}'s live location*\n${loc}`);

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
  await markNannyCancelled(booking, { reason, nannyId: ctx.session.user });

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

${nannyDisplayName(nanny)} has cancelled Booking #${booking.bookingNumber}.

Don't worry — here are available replacement nannies:

${M.nannyListing(replacements.slice(0, 3), { startIndex: 0, total: replacements.length })}

Or type *0* and go to My Bookings to cancel for a full refund.`);
  } else {
    await notifyUser(family, `🔴 *Your nanny has cancelled*

${nannyDisplayName(nanny)} has cancelled Booking #${booking.bookingNumber}.

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

Rate: ${money(nannyBookingPay(booking, ctx.session.user).rate)}/hr
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
