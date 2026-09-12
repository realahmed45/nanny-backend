import {
  BOOKING_STATUS, BOOKING_SUBSTATUS,
} from '../utils/constants.js';

/**
 * A nanny answering a booking request: accept or decline.
 *
 * Lifted out of the WhatsApp handler so the phone app can do the same thing.
 * The rules here are not obvious — a declined *change* leaves the original
 * booking standing while a declined *booking* releases the nanny and starts
 * the replacement hunt, and getting that backwards either strands a family or
 * cancels a job nobody cancelled. One copy, called from both doors.
 *
 * Returns what happened rather than a message, because the two callers say it
 * differently: WhatsApp sends a formatted reply, the app renders a screen.
 */

export async function respondToBookingRequest({ booking, nanny, accept, reason = '' }) {
  const { User } = await import('../models/index.js');
  const { notifyUser } = await import('../services/notify.js');
  const M = await import('../utils/messages.js');

  const pending = (booking.nannyResponses || []).find(
    (r) => String(r.nanny) === String(nanny._id) && r.outcome === 'pending',
  );
  if (!pending) return { ok: false, reason: 'no_pending_request' };
  if (new Date(pending.expiresAt) < new Date()) return { ok: false, reason: 'expired' };

  const isChange = pending.kind === 'booking_change';
  const family = await User.findById(booking.family);

  pending.respondedAt = new Date();

  if (accept) {
    pending.outcome = 'accepted';

    if (isChange) {
      const { applyPendingChange } = await import('../flows/familyBookingActions.js');
      await applyPendingChange(booking);
      await notifyUser(family, `✅ *Booking Updated*

${nanny.fullName} has accepted your changes to Booking #${booking.bookingNumber}.

${M.bookingSummary(booking, { showId: true, nanny, paid: true, showStatus: true })}`).catch(() => {});
    } else {
      booking.subStatus = BOOKING_SUBSTATUS.NANNY_CONFIRMED;
      // An ongoing booking stays ongoing; only a not-yet-started one moves up.
      if (booking.status !== BOOKING_STATUS.ONGOING) booking.status = BOOKING_STATUS.UPCOMING;
      await booking.save();
      await notifyUser(family, `🎉 *Booking Confirmed!*

${nanny.fullName} has accepted your booking.

${M.bookingSummary(booking, { showId: true, nanny, paid: true, showStatus: true })}`).catch(() => {});
    }

    return { ok: true, accepted: true, isChange, booking };
  }

  pending.outcome = 'declined';
  pending.declineReason = reason || 'No reason given';

  if (isChange) {
    // The change is refused, not the booking: she keeps the job as originally
    // agreed, and the family may pick someone else if the change matters.
    booking.pendingChange = undefined;
    booking.subStatus = BOOKING_SUBSTATUS.NANNY_CONFIRMED;
    await booking.save();
  } else {
    const nannyId = booking.nanny;
    if (nannyId && !booking.rejectedNannies.some((id) => String(id) === String(nannyId))) {
      // Recorded so she is not offered the same booking again on the next pass.
      booking.rejectedNannies.push(nannyId);
    }
    booking.nanny = undefined;
    booking.subStatus = BOOKING_SUBSTATUS.NANNY_CANCELLED_AWAITING_REPLACEMENT;
    await booking.save();
  }

  const { notifyFamilyOfDecline } = await import('../flows/nannyMenu.js');
  await notifyFamilyOfDecline(booking, isChange).catch(() => {});

  return { ok: true, accepted: false, isChange, booking };
}

export default { respondToBookingRequest };
