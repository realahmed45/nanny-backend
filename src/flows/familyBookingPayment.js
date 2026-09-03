import { on } from './engine.js';
import { User, Booking, ChatThread } from '../models/index.js';
import { BOOKING_STATUS, BOOKING_SUBSTATUS, USER_ROLE } from '../utils/constants.js';
import { parseChoice, clean, lower } from '../utils/parse.js';
import { draftToBooking } from './familyFindNanny.js';
import { createBooking } from '../services/booking.js';
import { recordTransfer } from '../services/payments.js';
import { notifyUser } from '../services/notify.js';
import { nannyDisplayName, firstName } from '../utils/format.js';
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
    { text: M.PAY_FIRST_NOTICE(nannyDisplayName(nanny)), state: 'FF_PAY_CONFIRM' },
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
    text: M.CHAT_OPENED(nannyDisplayName(nanny)),
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

  // Numbers are stripped before relaying: the whole point of the relay is
  // that neither side gets the other's contact details.
  const { redactContactDetails, CONTACT_BLOCKED_NOTICE } =
    await import('../utils/contactFilter.js');
  const safe = redactContactDetails(text);

  const family = await User.findById(ctx.session.user);
  thread.messages.push({
    from: 'family', sender: family?._id, body: safe.text, mediaUrl: ctx.mediaUrl,
  });
  thread.lastMessageAt = new Date();
  await thread.save();

  const nanny = await User.findById(thread.nanny);
  if (nanny) {
    const name = firstName(family?.fullName);
    const label = name ? `👨‍👩‍👧 ${name}` : '👨‍👩‍👧 Family';
    await notifyUser(nanny, `${label}:\n${safe.text}`);
  }

  // Tell the sender what happened, or their message looks ignored.
  return safe.redacted ? CONTACT_BLOCKED_NOTICE : null;
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
    return M.PAY_FIRST_NOTICE(nannyDisplayName(nanny));
  }

  const family = await User.findById(ctx.session.user);

  // ID card is a one-time requirement — skip it once we already hold one.
  if (family?.idVerified || (family?.idDocuments?.length >= 2)) {
    const started = await beginTransfer(ctx);
    return [{ text: M.PAYMENT_START }, started];
  }
  return [
    { text: M.PAYMENT_START },
    { text: M.ASK_ID_FRONT, state: 'FF_ID_FRONT' },
  ];
};
payConfirmHandler.prompt = async (ctx) => {
  const nanny = await User.findById(ctx.get('selectedNannyId'));
  return M.PAY_FIRST_NOTICE(nannyDisplayName(nanny));
};
on('FF_PAY_CONFIRM', payConfirmHandler);

on('FF_PAY_ABORT_CONFIRM', async (ctx) => {
  const choice = parseChoice(ctx.text, 2);
  if (!choice) return '1. Yes, cancel\n2. No, continue';
  if (choice === 1) {
    return { text: M.FAMILY_MAIN_MENU, state: 'FAMILY_MAIN_MENU', resetData: true, clearStack: true };
  }
  const nanny = await User.findById(ctx.get('selectedNannyId'));
  return { text: M.PAY_FIRST_NOTICE(nannyDisplayName(nanny)), state: 'FF_PAY_CONFIRM' };
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
  return beginTransfer(ctx);
};
idBackHandler.prompt = () => M.ASK_ID_BACK;
on('FF_ID_BACK', idBackHandler);

/* ------------------------------------------------------------------ *
 * Manual bank transfer: show the bank details, collect a screenshot, then
 * wait for an admin to verify it. No gateway is involved, so a booking is
 * only ever marked paid by a human checking the transfer arrived.
 * ------------------------------------------------------------------ */

/** After the ID step: create the booking and ask for the transfer. */
async function beginTransfer(ctx) {
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

  // Family provided an ID for the first time -> remember it for later bookings.
  if (!family.idVerified && (family.idDocuments || []).length >= 2) {
    family.idVerified = true;
  }
  if (booking.children?.length) family.children = booking.children;
  if (booking.otherInstructions) family.familyInstructions = booking.otherInstructions;
  family.agentCallRequested = booking.agentCallRequested;
  await family.save();

  ctx.set('payingBookingId', String(booking._id));
  return {
    text: M.bankTransferInstructions(booking.totalAmount),
    state: 'FF_AWAIT_PROOF',
  };
}

/**
 * The family sends the screenshot. We store it against a pending payment and
 * hand it to the admin queue — the nanny is NOT notified yet, because the
 * money has not been confirmed.
 */
const awaitProofHandler = async (ctx) => {
  if (!ctx.mediaUrl) {
    return `\u{1F4CE} Please attach the screenshot as an image.\n\n${M.ASK_PAYMENT_PROOF}`;
  }

  const bookingId = ctx.get('payingBookingId') || ctx.get('additionalPaymentBookingId');
  const booking = await Booking.findById(bookingId);
  if (!booking) return { text: M.INVALID_CHOICE, state: 'FAMILY_MAIN_MENU' };

  const isAdditional = Boolean(ctx.get('additionalPaymentBookingId'));
  await recordTransfer(booking, {
    amount: isAdditional ? booking.additionalDue : booking.totalAmount,
    kind: isAdditional ? 'additional' : 'booking',
    proof: { url: ctx.mediaUrl, mediaId: ctx.mediaId, note: clean(ctx.text) },
  });

  booking.status = BOOKING_STATUS.PENDING_PAYMENT;
  await booking.save();

  return [
    { text: M.PAYMENT_PROOF_RECEIVED },
    {
      text: M.bookingSummary(booking, { showId: true, showStatus: true }),
      state: 'FAMILY_MAIN_MENU',
      resetData: true,
      clearStack: true,
    },
  ];
};
awaitProofHandler.prompt = async (ctx) => {
  const booking = await Booking.findById(
    ctx.get('payingBookingId') || ctx.get('additionalPaymentBookingId')
  );
  return booking
    ? M.bankTransferInstructions(booking.additionalDue || booking.totalAmount)
    : M.ASK_PAYMENT_PROOF;
};
on('FF_AWAIT_PROOF', awaitProofHandler);

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

/** An admin rejected the proof — let the family retry or reach support. */
const paymentRejectedHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, 3);
  if (!choice) return M.PAYMENT_REJECTED_ACTIONS;

  if (choice === 1) {
    const booking = await Booking.findById(ctx.get('payingBookingId'));
    return {
      text: booking ? M.bankTransferInstructions(booking.additionalDue || booking.totalAmount)
                    : M.ASK_PAYMENT_PROOF,
      state: 'FF_AWAIT_PROOF',
    };
  }
  if (choice === 2) return { text: 'Connecting you to support\u{2026}', state: 'SUPPORT_MENU' };
  return { text: M.FAMILY_MAIN_MENU, state: 'FAMILY_MAIN_MENU', resetData: true };
};
paymentRejectedHandler.prompt = () => M.PAYMENT_REJECTED_ACTIONS;
on('FF_PAYMENT_REJECTED', paymentRejectedHandler);

export default { showPreBookingSummary, openChatWithNanny, setNannyRequestState };
