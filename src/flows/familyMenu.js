import dayjs from 'dayjs';
import { on, mainMenuFor } from './engine.js';
import { User, Booking, ChatThread } from '../models/index.js';
import {
  BOOKING_STATUS, BOOKING_SUBSTATUS, SERVICE_DAY_STATUS, USER_ROLE,
} from '../utils/constants.js';
import { parseChoice, clean, lower } from '../utils/parse.js';
import { startFindNanny } from './familyFindNanny.js';
import { statusLabel, prettyDate, timeRange, money } from '../utils/format.js';
import config from '../config/index.js';
import * as M from '../utils/messages.js';

export const MY_BOOKINGS_MENU = `📅 *My Bookings*

Choose a category:

1. Upcoming
2. Ongoing
3. Completed
4. Cancelled
5. Bookings Pending for Additional Payment

Type *0* Return to Main Menu`;

/* ------------------------------------------------------------------ *
 * Family main menu
 * ------------------------------------------------------------------ */

const familyMenuHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, 6);
  if (!choice) return M.FAMILY_MAIN_MENU;

  // Everything past "Find a Nanny" needs a registered account.
  if (!ctx.session.user && choice !== 1) {
    return {
      text: `You'll need an account first.\n\n${M.ASK_FULL_NAME}`,
      state: 'FAMILY_REG_NAME',
    };
  }

  switch (choice) {
    case 1: {
      if (!ctx.session.user) {
        return { text: M.ASK_FULL_NAME, state: 'FAMILY_REG_NAME' };
      }
      return startFindNanny(ctx);
    }
    case 2: return { text: MY_BOOKINGS_MENU, state: 'FB_BOOKINGS_MENU' };
    case 3: return { text: PROFILE_MENU, state: 'FP_MENU' };
    case 4: return { text: PAYMENTS_MENU, state: 'FPAY_MENU' };
    case 5: return showReferral(ctx);
    case 6: return { text: SUPPORT_MENU_TEXT, state: 'SUPPORT_MENU' };
    default: return M.FAMILY_MAIN_MENU;
  }
};
familyMenuHandler.prompt = () => M.FAMILY_MAIN_MENU;
on('FAMILY_MAIN_MENU', familyMenuHandler);

/* ------------------------------------------------------------------ *
 * My Bookings
 * ------------------------------------------------------------------ */

/** Query for one of the five booking categories. */
export function categoryQuery(familyId, category) {
  const base = { family: familyId };
  switch (category) {
    case 'upcoming':
      return { ...base, status: BOOKING_STATUS.UPCOMING };
    case 'ongoing':
      return { ...base, status: BOOKING_STATUS.ONGOING };
    case 'completed':
      return { ...base, status: BOOKING_STATUS.COMPLETED };
    case 'cancelled':
      return { ...base, status: BOOKING_STATUS.CANCELLED };
    case 'pending_additional':
      return { ...base, status: BOOKING_STATUS.PENDING_ADDITIONAL_PAYMENT };
    default:
      return base;
  }
}

const CATEGORY_LABELS = {
  upcoming: 'upcoming', ongoing: 'ongoing', completed: 'completed',
  cancelled: 'cancelled', pending_additional: 'pending additional payment',
};

/** One-line-per-booking list, as in the script. */
export async function renderBookingList(bookings, category) {
  if (!bookings.length) {
    return `You have no ${CATEGORY_LABELS[category]} bookings.\n\nType *0* to return to the Main Menu, or *Back* for My Bookings.`;
  }
  const head = `You have *${bookings.length} ${CATEGORY_LABELS[category]} booking${bookings.length > 1 ? 's' : ''}.*\nReply with the booking number to view details.\n`;
  const rows = await Promise.all(bookings.map(async (b, i) => {
    const nanny = b.nanny ? await User.findById(b.nanny).select('fullName') : null;
    const nannyLine = nanny ? `👩  ${nanny.fullName}` : '👩  Nanny Replacement Needed';
    const dateLine = b.isMultiDay
      ? `📅  ${prettyDate(b.startDate)} – ${prettyDate(b.endDate)} (${(b.serviceDays || []).length} days)`
      : `📅  ${prettyDate(b.startDate)}`;
    return `*${i + 1}. Booking ID #${b.bookingNumber}*\n\n${nannyLine}\n${dateLine}\n⏰  ${timeRange(b.startTime, b.hoursPerDay)}\nStatus: ${statusLabel(b)}`;
  }));
  return head + '\n' + rows.join('\n\n');
}

const bookingsMenuHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, 5);
  if (!choice) return MY_BOOKINGS_MENU;

  const categories = ['upcoming', 'ongoing', 'completed', 'cancelled', 'pending_additional'];
  const category = categories[choice - 1];

  const bookings = await Booking.find(categoryQuery(ctx.session.user, category)).sort({ startDate: 1 });
  const text = await renderBookingList(bookings, category);

  return {
    text,
    state: 'FB_BOOKING_LIST',
    listing: { kind: 'bookings', ids: bookings.map((b) => String(b._id)), page: 0, pageSize: 50 },
    data: { bookingCategory: category },
  };
};
bookingsMenuHandler.prompt = () => MY_BOOKINGS_MENU;
on('FB_BOOKINGS_MENU', bookingsMenuHandler);

const bookingListHandler = async (ctx) => {
  const listing = ctx.session.listing;
  const ids = listing?.ids || [];
  if (!ids.length) return { text: MY_BOOKINGS_MENU, state: 'FB_BOOKINGS_MENU' };

  // Accept either the row number or the booking ID typed directly.
  let bookingId = null;
  const n = parseChoice(ctx.text, ids.length);
  if (n) bookingId = ids[n - 1];
  else {
    const typed = clean(ctx.text).replace(/^#/, '');
    const match = await Booking.findOne({ bookingNumber: typed, family: ctx.session.user });
    if (match) bookingId = String(match._id);
  }
  if (!bookingId) return M.INVALID_CHOICE;

  return showBookingDetail(ctx, bookingId);
};
bookingListHandler.prompt = async (ctx) => {
  const category = ctx.get('bookingCategory', 'upcoming');
  const bookings = await Booking.find(categoryQuery(ctx.session.user, category)).sort({ startDate: 1 });
  return renderBookingList(bookings, category);
};
on('FB_BOOKING_LIST', bookingListHandler);

/** Full detail card + the action menu appropriate to the booking's state. */
export async function showBookingDetail(ctx, bookingId) {
  const booking = await Booking.findById(bookingId);
  if (!booking) return M.INVALID_CHOICE;

  const nanny = booking.nanny ? await User.findById(booking.nanny) : null;
  ctx.set('activeBookingId', String(booking._id));

  const detail = M.bookingSummary(booking, {
    showId: true, nanny, paid: booking.paidAmount > 0, showStatus: true,
  });
  const menu = await bookingActionMenu(booking);

  return [
    { text: `Here are the details\n\n${detail}` },
    { text: menu.text, state: menu.state },
  ];
}

/**
 * Build the action menu for a booking. Options vary by status/sub-status
 * exactly as laid out in the spec's booking-actions table.
 */
export async function bookingActionMenu(booking) {
  const opts = [];
  const now = new Date();
  const firstDay = booking.serviceDays?.[0];
  const liveWindowOpen = firstDay &&
    (new Date(firstDay.startAt) - now) <= config.liveLocationWindowHours * 3600e3;

  // --- Replacement needed (nanny cancelled) ---
  if (booking.subStatus === BOOKING_SUBSTATUS.NANNY_CANCELLED_AWAITING_REPLACEMENT) {
    opts.push('View Replacement Nannies', 'Cancel Booking', 'Contact Support');
    return { text: menuText(opts), state: 'FB_ACTION_REPLACEMENT' };
  }

  // --- Pending additional payment ---
  if (booking.status === BOOKING_STATUS.PENDING_ADDITIONAL_PAYMENT) {
    opts.push('Pay Now', 'Show nannies within my previous budget', 'Cancel Booking');
    return { text: menuText(opts), state: 'FB_ACTION_ADDITIONAL' };
  }

  // --- Completed ---
  if (booking.status === BOOKING_STATUS.COMPLETED) {
    opts.push('Rate Nanny', 'Book this Nanny Again', 'Download Payment Receipt');
    return { text: menuText(opts), state: 'FB_ACTION_COMPLETED' };
  }

  // --- Cancelled: view only ---
  if (booking.status === BOOKING_STATUS.CANCELLED) {
    return {
      text: 'This booking was cancelled.\n\nType *Back* to go back to My Bookings, or *0* for the Main Menu.',
      state: 'FB_ACTION_CANCELLED',
    };
  }

  // --- Ongoing ---
  if (booking.status === BOOKING_STATUS.ONGOING) {
    const sub = booking.subStatus;
    if (sub === BOOKING_SUBSTATUS.AWAITING_ARRIVAL) opts.push('Confirm Nanny Arrival');
    opts.push('Message Nanny', 'View Nanny Profile');

    if (sub === BOOKING_SUBSTATUS.AWAITING_END_OF_SERVICE) {
      opts.push('Show End-of-Service Code');
    }
    opts.push(booking.liveLocation?.familySharing ? 'Stop Sharing Live Location' : 'Start Sharing Live Location');
    if (booking.liveLocation?.nannySharing) opts.push("View Nanny's Live Location");
    opts.push('Report an Issue');

    // Multi-day ongoing bookings may still be edited (with penalties).
    if (booking.isMultiDay) {
      opts.push('Reschedule Booking', 'Change Address', 'Change Skills, Language or Budget', 'Change Nanny');
    }
    opts.push('Cancel Booking');
    return { text: menuText(opts), state: 'FB_ACTION_ONGOING' };
  }

  // --- Upcoming ---
  opts.push('Message Nanny', 'View Nanny Profile', 'Reschedule Booking', 'Change Address',
    'Change Skills, Language or Budget', 'Change Nanny', 'Cancel Booking');
  if (booking.subStatus === BOOKING_SUBSTATUS.NANNY_CONFIRMED && liveWindowOpen) {
    opts.push('Start Sharing Live Location');
    if (booking.liveLocation?.nannySharing) opts.push("View Nanny's Live Location");
  }
  return { text: menuText(opts), state: 'FB_ACTION_UPCOMING' };
}

export function menuText(options) {
  return `What would you like to do?\n\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n\nType *BACK* to go back to My Bookings`;
}

/* ------------------------------------------------------------------ *
 * Placeholders wired up by the other flow modules
 * ------------------------------------------------------------------ */

export const PROFILE_MENU = `\u{1F464} *My Profile*

What would you like to manage?

1. Personal Information
2. Saved Addresses
3. My Children
4. Favourite Nannies
5. Identity Verification
6. Emergency Contacts

Type *0* Return to Main Menu`;

export const PAYMENTS_MENU = `💳 *My Payments*

Choose a category:

1. Payment Completed
2. Payment In Process
3. Refund In Process
4. Refunded
5. Payment Failed

Type *0* Return to Main Menu`;

export const SUPPORT_MENU_TEXT = `\u{1F198} *Help / Support*

How can we help you?

1. \u{1F4C5} Booking Issue
2. \u{1F4B3} Payment & Refunds
3. \u{1F469} Nanny Issue
4. \u{2699}\u{FE0F} Technical Problem
5. \u{1F464} Talk to an Agent
6. \u{2753} FAQs
7. \u{1F3AB} My Support Tickets

Type *0* Return to Main Menu`;

export async function showReferral(ctx) {
  const user = await User.findById(ctx.session.user);
  if (!user) return { text: M.FAMILY_MAIN_MENU, state: 'FAMILY_MAIN_MENU' };
  if (!user.referralCode) {
    const { makeReferralCode } = await import('./common.js');
    user.referralCode = makeReferralCode(user.fullName);
    await user.save();
  }
  const link = `${config.publicBaseUrl}/r/${user.referralCode}`;
  return {
    text: `🎁 *Refer a Friend*

Share My Nanny with your friends and earn rewards!

Your referral code: *${user.referralCode}*
Your link: ${link}

👥 Friends referred: *${user.referralCount || 0}*
💰 Rewards earned: *${money(user.referralEarnings || 0)}*

Type *0* to return to the Main Menu.`,
    state: 'FAMILY_MAIN_MENU',
  };
}

export default { MY_BOOKINGS_MENU, renderBookingList, showBookingDetail, bookingActionMenu, menuText, categoryQuery };
