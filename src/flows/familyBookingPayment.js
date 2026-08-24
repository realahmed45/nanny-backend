import { on } from './engine.js';
import { User, Booking, ChatThread } from '../models/index.js';
import { BOOKING_STATUS, BOOKING_SUBSTATUS, USER_ROLE } from '../utils/constants.js';
import { parseChoice, clean, lower } from '../utils/parse.js';
import { draftToBooking } from './familyFindNanny.js';
import { createBooking, openNannyResponseWindow } from '../services/booking.js';
import { chargeBooking } from '../services/payments.js';
import { notifyUser } from '../services/notify.js';
import * as M from '../utils/messages.js';

/* ------------------------------------------------------------------ *
 * Nanny profile actions -> book / chat / view others
 * ------------------------------------------------------------------ */

const profileHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, 3);
  if (!choice) return M.NANNY_PROFILE_ACTIONS;

  const nanny = await User.findById(ctx.get('selectedNannyId'));
  if (!nanny) return M.INVALID_CHOICE;

  if (choice === 1) return showPreBookingSummary(ctx, nanny);
  if (choice === 2) return openChatWithNanny(ctx, nanny);

  // View other nannies -> back to the listing.
  const { renderListingPage } = await import('./familyFindNanny.js');
  const page = await renderListingPage(ctx);
  return { text: page || M.INVALID_CHOICE, state: 'FF_NANNY_LISTING' };
};
profileHandler.prompt = () => M.NANNY_PROFILE_ACTIONS;
on('FF_NANNY_PROFILE', profileHandler);

/** Summary priced at the selected nanny's rate, then the pay-first notice. */
export async function showPreBookingSummary(ctx, nanny) {
  ctx.set('selectedNannyId', String(nanny._id));
  const preview = draftToBooking(ctx, { hourlyRate: nanny.hourlyRate });
  return [
    { text: M.bookingSummary(preview, { title: '*Booking Summary*', nanny }) },
    { text: M.PAY_FIRST_NOTICE(nanny.fullName), state: 'FF_PAY_CONFIRM' },
  ];
}

/* ------------------------------------------------------------------ *
 * Family <-> nanny chat relay (numbers stay private)
 * ------------------------------------------------------------------ */

export async function openChatWithNanny(ctx, nanny, booking = null) {
  const familyId = ctx.session.user;
  let thread = await ChatThread.findOne({
    family: familyId, nanny: nanny._id, booking: booking?._id || null, closed: false,
  });
  if (!thread) {
    thread = await ChatThread.create({
      family: familyId, nanny: nanny._id, booking: booking?._id || null,
    });
  }
  thread.familyActive = true;
  await thread.save();

  return {
    text: M.CHAT_OPENED(nanny.fullName),
    state: 'FF_CHATTING',
    activeChat: thread._id,
    data: { chatNannyId: String(nanny._id) },
  };
}

/**
 * While chatting, everything the family types is relayed to the nanny verbatim
 * — except BYE, which closes the chat. `allowCommands` stops the engine from
 * eating messages like "0" or "back" that are meant for the nanny.
 */
const chattingHandler = async (ctx) => {
  const text = clean(ctx.text);

  // '0' escapes the relay the same way BYE does, so a user can never be
  // trapped in chat mode with no way back to the menu.
  const leaving = lower(text) === 'bye' || text === '0';
  if (leaving) {
    const thread = await ChatThread.findById(ctx.session.activeChat);
    if (thread) {
      thread.familyActive = false;
      await thread.save();
      const nanny = await User.findById(thread.nanny);
      if (nanny && thread.nannyActive) {
        await notifyUser(nanny, '💬 The family has closed the chat.');
      }
    }
    return { text: M.CHAT_CLOSED_ACTIONS, state: 'FF_CHAT_CLOSED', activeChat: null };
  }

  const thread = await ChatThread.findById(ctx.session.activeChat);
  if (!thread) {
    return { text: M.FAMILY_MAIN_MENU, state: 'FAMILY_MAIN_MENU' };
  }

  const family = await User.findById(ctx.session.user);
  thread.messages.push({
    from: 'family', sender: family?._id, body: text, mediaUrl: ctx.mediaUrl,
  });
  thread.lastMessageAt = new Date();
  await thread.save();

  const nanny = await User.findById(thread.nanny);
  if (nanny) {
    const label = family?.fullName ? `👨‍👩‍👧 ${family.fullName}` : '👨‍👩‍👧 Family';
    await notifyUser(nanny, `${label}:\n${text}`);
  }
  return null;  // no bot reply; the message was relayed
};
chattingHandler.allowCommands = true;
on('FF_CHATTING', chattingHandler);

const chatClosedHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, 3);
  if (!choice) return M.CHAT_CLOSED_ACTIONS;

  const nanny = await User.findById(ctx.get('chatNannyId') || ctx.get('selectedNannyId'));
  if (!nanny) return M.INVALID_CHOICE;

  if (choice === 1) return showPreBookingSummary(ctx, nanny);
  if (choice === 2) return openChatWithNanny(ctx, nanny);

  const { renderListingPage } = await import('./familyFindNanny.js');
  const page = await renderListingPage(ctx);
  return { text: page || M.INVALID_CHOICE, state: 'FF_NANNY_LISTING' };
};
chatClosedHandler.prompt = () => M.CHAT_CLOSED_ACTIONS;
on('FF_CHAT_CLOSED', chatClosedHandler);

/* ------------------------------------------------------------------ *
 * Payment
 * ------------------------------------------------------------------ */

const payConfirmHandler = async (ctx) => {
  const t = lower(ctx.text);
  const choice = parseChoice(ctx.text, 2);

  const proceed = choice === 1 || t.includes('start payment') || t === 'pay';
  const abort = choice === 2 || t === 'cancel';

  if (abort) {
    return {
      text: `Are you sure? All the booking data will be lost.\n\n1. Yes, cancel\n2. No, continue`,
      state: 'FF_PAY_ABORT_CONFIRM',
    };
  }
  if (!proceed) {
    const nanny = await User.findById(ctx.get('selectedNannyId'));
    return M.PAY_FIRST_NOTICE(nanny?.fullName || 'this nanny');
  }

  const family = await User.findById(ctx.session.user);

  // ID card is a one-time requirement — skip it once we already hold one.
  if (family?.idVerified || (family?.idDocuments?.length >= 2)) {
    return [
      { text: M.PAYMENT_START },
      { text: M.ASK_PAYMENT_METHOD, state: 'FF_PAYMENT_METHOD' },
    ];
  }
  return [
    { text: M.PAYMENT_START },
    { text: M.ASK_ID_FRONT, state: 'FF_ID_FRONT' },
  ];
};
payConfirmHandler.prompt = async (ctx) => {
  const nanny = await User.findById(ctx.get('selectedNannyId'));
  return M.PAY_FIRST_NOTICE(nanny?.fullName || 'this nanny');
};
on('FF_PAY_CONFIRM', payConfirmHandler);

on('FF_PAY_ABORT_CONFIRM', async (ctx) => {
  const choice = parseChoice(ctx.text, 2);
  if (!choice) return '1. Yes, cancel\n2. No, continue';
  if (choice === 1) {
    return { text: M.FAMILY_MAIN_MENU, state: 'FAMILY_MAIN_MENU', resetData: true, clearStack: true };
  }
  const nanny = await User.findById(ctx.get('selectedNannyId'));
  return { text: M.PAY_FIRST_NOTICE(nanny?.fullName || 'this nanny'), state: 'FF_PAY_CONFIRM' };
});

const idFrontHandler = async (ctx) => {
  if (!ctx.mediaUrl) return `📎 Please attach a photo.\n\n${M.ASK_ID_FRONT}`;
  const family = await User.findById(ctx.session.user);
  family.idDocuments = (family.idDocuments || []).filter((d) => d.type !== 'id_front');
  family.idDocuments.push({ type: 'id_front', url: ctx.mediaUrl, mediaId: ctx.mediaId });
  await family.save();
  return { text: M.ASK_ID_BACK, state: 'FF_ID_BACK' };
};
idFrontHandler.prompt = () => M.ASK_ID_FRONT;
on('FF_ID_FRONT', idFrontHandler);

const idBackHandler = async (ctx) => {
  if (!ctx.mediaUrl) return `📎 Please attach a photo.\n\n${M.ASK_ID_BACK}`;
  const family = await User.findById(ctx.session.user);
  family.idDocuments = (family.idDocuments || []).filter((d) => d.type !== 'id_back');
  family.idDocuments.push({ type: 'id_back', url: ctx.mediaUrl, mediaId: ctx.mediaId });
  await family.save();
  return { text: M.ASK_PAYMENT_METHOD, state: 'FF_PAYMENT_METHOD' };
};
idBackHandler.prompt = () => M.ASK_ID_BACK;
on('FF_ID_BACK', idBackHandler);

const paymentMethodHandler = async (ctx) => {
  const t = lower(ctx.text);
  let method = null;
  const choice = parseChoice(ctx.text, 2);
  if (choice === 1 || t.includes('card')) method = 'credit_card';
  else if (choice === 2 || t.includes('bank') || t.includes('transfer')) method = 'bank_transfer';
  if (!method) return M.ASK_PAYMENT_METHOD;

  // Paying an outstanding difference on an existing booking?
  const pendingId = ctx.get('additionalPaymentBookingId');
  if (pendingId) return processAdditionalPayment(ctx, pendingId, method);

  return processNewBookingPayment(ctx, method);
};
paymentMethodHandler.prompt = () => M.ASK_PAYMENT_METHOD;
on('FF_PAYMENT_METHOD', paymentMethodHandler);

/** Create the booking, take payment, then notify the nanny (1-hour clock). */
async function processNewBookingPayment(ctx, method) {
  const family = await User.findById(ctx.session.user);
  const nanny = await User.findById(ctx.get('selectedNannyId'));
  if (!nanny) return { text: M.INVALID_CHOICE, state: 'FAMILY_MAIN_MENU' };

  const booking = await createBooking({
    family, nanny,
    draft: {
      ...ctx.session.data,
      endDate: ctx.get('isMultiDay') ? ctx.get('endDate') : ctx.get('startDate'),
      repeatDays: ctx.get('isMultiDay') ? ctx.get('repeatDays') : [],
      address: ctx.get('address') || { mapUrl: ctx.get('mapUrl'), addressLine: ctx.get('addressLine') },
    },
  });

  const result = await chargeBooking(booking, { method });

  if (!result.success) {
    ctx.set('failedBookingId', String(booking._id));
    return [
      { text: M.PAYMENT_PROCESSING },
      { text: M.PAYMENT_FAILED, state: 'FF_PAYMENT_FAILED' },
    ];
  }

  // Family provided an ID for the first time -> mark verified for later bookings.
  if (!family.idVerified && (family.idDocuments || []).length >= 2) {
    family.idVerified = true;
  }
  // Persist the children/instructions onto the family profile for reuse.
  if (booking.children?.length) family.children = booking.children;
  if (booking.otherInstructions) family.familyInstructions = booking.otherInstructions;
  family.agentCallRequested = booking.agentCallRequested;
  await family.save();

  booking.status = BOOKING_STATUS.UPCOMING;
  const { expiresAt } = openNannyResponseWindow(booking, nanny._id, 'new_booking');
  await booking.save();

  await notifyUser(nanny, M.nannyBookingRequest(booking, family, expiresAt));
  await setNannyRequestState(nanny, booking);

  return [
    { text: M.PAYMENT_PROCESSING },
    { text: M.PAYMENT_SUCCESS },
    {
      text: M.bookingSummary(booking, { showId: true, nanny, paid: true, showStatus: true }),
      state: 'FAMILY_MAIN_MENU',
      resetData: true,
      clearStack: true,
    },
    { text: M.FAMILY_MAIN_MENU },
  ];
}

/** Put the nanny's session into the accept/decline state for this booking. */
export async function setNannyRequestState(nanny, booking) {
  const { Session } = await import('../models/index.js');
  const session = await Session.findOne({ phone: nanny.phone });
  if (!session) return;
  session.state = 'NANNY_BOOKING_REQUEST';
  session.data = { ...(session.data || {}), requestBookingId: String(booking._id) };
  session.markModified('data');
  await session.save();
}

async function processAdditionalPayment(ctx, bookingId, method) {
  const booking = await Booking.findById(bookingId).populate('nanny');
  if (!booking) return { text: M.INVALID_CHOICE, state: 'FAMILY_MAIN_MENU' };

  const result = await chargeBooking(booking, { method, amount: booking.additionalDue, kind: 'additional' });
  if (!result.success) {
    return [
      { text: M.PAYMENT_PROCESSING },
      { text: M.PAYMENT_FAILED, state: 'FF_PAYMENT_FAILED' },
    ];
  }

  booking.hourlyRate = booking.nanny?.hourlyRate ?? booking.hourlyRate;
  booking.totalAmount = (booking.totalAmount || 0) + (result.payment.amount || 0);
  booking.additionalDue = 0;
  booking.status = BOOKING_STATUS.UPCOMING;

  const family = await User.findById(booking.family);
  const { expiresAt } = openNannyResponseWindow(booking, booking.nanny._id, 'new_booking');
  await booking.save();

  await notifyUser(booking.nanny, M.nannyBookingRequest(booking, family, expiresAt));
  await setNannyRequestState(booking.nanny, booking);

  ctx.set('additionalPaymentBookingId', null);
  return [
    { text: M.PAYMENT_PROCESSING },
    { text: '✅ Additional payment successful. Waiting for nanny confirmation.' },
    {
      text: M.bookingSummary(booking, { showId: true, nanny: booking.nanny, paid: true, showStatus: true }),
      state: 'FAMILY_MAIN_MENU',
      resetData: true,
    },
  ];
}

const paymentFailedHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, 4);
  if (!choice) return M.PAYMENT_FAILED;
  if (choice === 1 || choice === 2) {
    return { text: M.ASK_PAYMENT_METHOD, state: 'FF_PAYMENT_METHOD' };
  }
  if (choice === 3) return { text: 'Connecting you to support…', state: 'SUPPORT_MENU' };
  return { text: M.FAMILY_MAIN_MENU, state: 'FAMILY_MAIN_MENU', resetData: true };
};
paymentFailedHandler.prompt = () => M.PAYMENT_FAILED;
on('FF_PAYMENT_FAILED', paymentFailedHandler);

export default { showPreBookingSummary, openChatWithNanny, setNannyRequestState };
