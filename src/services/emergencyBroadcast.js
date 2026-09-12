import { User, Booking } from '../models/index.js';
import { USER_ROLE, NANNY_STATUS, BOOKING_STATUS, BOOKING_SUBSTATUS } from '../utils/constants.js';
import { notifyUser } from './notify.js';
import { findNannies } from './matching.js';
import config from '../config/index.js';
import * as M from '../utils/messages.js';

/**
 * Emergency staffing: ask everyone at once, first to say yes gets the job.
 *
 * The ordinary flow offers a booking to one nanny and waits an hour for her
 * answer. That is right when there is time and wrong when a family needs
 * somebody within the hour — by the time the third nanny has been asked, the
 * booking is already late.
 *
 * So an emergency goes to every suitable nanny at the same time and is claimed
 * by whoever replies first. The others are told it has gone, which matters:
 * a nanny who arranges her afternoon around a job she did not get will not
 * answer the next one.
 *
 * The address is deliberately held back until someone accepts. A broadcast
 * naming a family's home to forty people is a privacy problem, and it is not
 * needed to decide whether you can take the work.
 */

/** How long the offer stands before we stop accepting answers. */
const CLAIM_WINDOW_MINUTES = 30;

/**
 * Who to ask.
 *
 * The same matching as an ordinary booking — she must be verified, free that
 * day, and able to do the hours — minus anyone who has already turned this
 * booking down. Skills and languages are treated as preferences rather than
 * requirements: in an emergency a family would rather have someone competent
 * now than the perfect match tomorrow.
 */
export async function findEmergencyCandidates(booking, { limit = 60 } = {}) {
  const req = booking.requirements || {};
  const rejected = (booking.rejectedNannies || []).map(String);

  /**
   * Anyone who has said, recently, that she could take a job right now.
   *
   * Being unbooked is not the same as being free: a nanny with a clear
   * afternoon may be at the beach. Asking the people who put their hand up
   * gets a faster yes and stops the other forty being messaged for nothing.
   *
   * Used as a preference, never a filter. When nobody has the switch on — a
   * quiet morning, or before the app is in anyone's hands — the broadcast
   * still goes to everyone available, because a family needing a nanny within
   * the hour is worse served by a tidy rule than by a message.
   */
  const nowAvailable = new Set(
    (await User.find({
      role: USER_ROLE.NANNY,
      emergencyAvailable: true,
      $or: [
        { emergencyAvailableUntil: null },
        { emergencyAvailableUntil: { $gt: new Date() } },
      ],
    }).select('_id').lean()).map((n) => String(n._id)),
  );

  /** Hands-up first, everyone else after, order otherwise untouched. */
  const handsUpFirst = (list) => [
    ...list.filter((n) => nowAvailable.has(String(n._id))),
    ...list.filter((n) => !nowAvailable.has(String(n._id))),
  ];

  const strict = await findNannies({
    languages: req.languages || [],
    skills: req.skills || [],
    serviceDays: booking.serviceDays || [],
    hoursPerDay: booking.hoursPerDay,
    excludeIds: rejected,
    excludeBookingId: booking._id,
    limit,
  });

  // Widen if a strict match would leave the family with nobody.
  if (strict.length >= 3) return handsUpFirst(strict);

  const loose = await findNannies({
    serviceDays: booking.serviceDays || [],
    hoursPerDay: booking.hoursPerDay,
    excludeIds: rejected,
    excludeBookingId: booking._id,
    limit,
  });

  const seen = new Set(strict.map((n) => String(n._id)));
  return handsUpFirst([...strict, ...loose.filter((n) => !seen.has(String(n._id)))]);
}

/**
 * Send the offer to everyone who could take it.
 *
 * Records who was asked on the booking, so a later acceptance can be checked
 * against the list and the losers can be told when it is gone.
 */
export async function broadcastEmergency(booking, { limit = 60 } = {}) {
  if (!booking?.isEmergency) {
    throw new Error('Only an emergency booking can be broadcast');
  }

  const candidates = await findEmergencyCandidates(booking, { limit });
  if (!candidates.length) {
    return { sent: 0, candidates: [], reason: 'no available nannies' };
  }

  const expiresAt = new Date(Date.now() + CLAIM_WINDOW_MINUTES * 60_000);
  const family = await User.findById(booking.family).select('fullName').lean();

  booking.emergencyBroadcast = {
    sentAt: new Date(),
    expiresAt,
    candidates: candidates.map((n) => n._id),
    claimedBy: null,
    declined: [],
  };
  booking.subStatus = BOOKING_SUBSTATUS.AWAITING_NANNY_CONFIRMATION;
  await booking.save();

  const message = M.emergencyBroadcast(booking, {
    hourlyBonus: config.emergencyHourlyBonus,
    surcharge: booking.emergencySurcharge || config.emergencySurcharge,
    family,
  });

  // Sent one at a time rather than in parallel: the provider rate-limits, and
  // a burst that gets throttled would reach nobody. Failures are logged and
  // skipped — one unreachable number must not stop the rest being asked.
  let sent = 0;
  for (const nanny of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await notifyUser(nanny, message);
      sent += 1;
    } catch (err) {
      console.error(`[emergency] could not reach ${nanny.phone}: ${err.message}`);
    }
  }

  console.log(`[emergency] booking ${booking.bookingNumber} offered to ${sent} nannies`);
  return { sent, candidates, expiresAt };
}

/**
 * A nanny says yes.
 *
 * The race is settled here. Two nannies can reply in the same second, so the
 * claim is a conditional update — only the request that finds the booking
 * still unclaimed wins, and the other is told plainly that it has gone rather
 * than being left to find out on the doorstep.
 */
export async function claimEmergency(bookingId, nannyId) {
  // Atomic: whoever matches `claimedBy: null` first is the one who gets it.
  const booking = await Booking.findOneAndUpdate(
    {
      _id: bookingId,
      isEmergency: true,
      'emergencyBroadcast.claimedBy': null,
      'emergencyBroadcast.expiresAt': { $gt: new Date() },
      status: { $ne: BOOKING_STATUS.CANCELLED },
    },
    {
      $set: {
        'emergencyBroadcast.claimedBy': nannyId,
        'emergencyBroadcast.claimedAt': new Date(),
        nanny: nannyId,
        subStatus: BOOKING_SUBSTATUS.NANNY_CONFIRMED,
      },
    },
    { new: true },
  );

  if (!booking) return { claimed: false, reason: 'taken' };

  const [nanny, family] = await Promise.all([
    User.findById(nannyId),
    User.findById(booking.family),
  ]);

  // Now — and only now — the address.
  await notifyUser(nanny, M.emergencyClaimed(booking, family));
  if (family) {
    await notifyUser(family, M.emergencyNannyFound(booking, nanny)).catch(() => {});
  }

  // Everyone else hears that it is gone. A nanny who kept her afternoon free
  // for a job she did not get will not answer the next broadcast.
  const others = (booking.emergencyBroadcast?.candidates || [])
    .filter((id) => String(id) !== String(nannyId));
  for (const id of others) {
    // eslint-disable-next-line no-await-in-loop
    const other = await User.findById(id);
    if (!other) continue;
    // eslint-disable-next-line no-await-in-loop
    await notifyUser(other, M.emergencyTaken(booking)).catch(() => {});
  }

  return { claimed: true, booking, nanny };
}

/**
 * A nanny says no, or ignores it.
 *
 * Both are the same outcome — she does not get the job — so declining costs
 * her nothing beyond being taken off this booking's list. It is recorded so
 * she is not asked about the same booking twice.
 */
export async function declineEmergency(bookingId, nannyId) {
  const booking = await Booking.findById(bookingId);
  if (!booking?.emergencyBroadcast) return { ok: false };

  const already = (booking.emergencyBroadcast.declined || []).some(
    (id) => String(id) === String(nannyId),
  );
  if (!already) {
    booking.emergencyBroadcast.declined.push(nannyId);
    if (!booking.rejectedNannies.some((id) => String(id) === String(nannyId))) {
      booking.rejectedNannies.push(nannyId);
    }
    booking.markModified('emergencyBroadcast');
    await booking.save();
  }
  return { ok: true, taken: !!booking.emergencyBroadcast.claimedBy };
}

export default {
  broadcastEmergency, claimEmergency, declineEmergency, findEmergencyCandidates,
};
