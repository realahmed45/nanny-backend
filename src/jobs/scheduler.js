import cron from 'node-cron';
import dayjs from 'dayjs';
import { Booking, User, Session } from '../models/index.js';
import {
  BOOKING_STATUS, BOOKING_SUBSTATUS, SERVICE_DAY_STATUS, CANCELLED_BY,
} from '../utils/constants.js';
import { syncBookingStatus, cancelBooking } from '../services/booking.js';
import { computeCancellationRefund } from '../services/policy.js';
import { refundBooking, releaseDuePayouts, queuePayout } from '../services/payments.js';
import { findReplacements } from '../services/matching.js';
import { notifyUser } from '../services/notify.js';
import { notifyFamilyOfDecline } from '../flows/nannyMenu.js';
import { prettyDate, timeRange, money } from '../utils/format.js';
import * as M from '../utils/messages.js';

/**
 * Background jobs. Each is exported so it can be invoked directly from tests
 * or the admin API; `startScheduler()` wires them to cron.
 */

/* ------------------------------------------------------------------ *
 * 1. Nanny response timeouts (1h new booking / 2h booking change)
 * ------------------------------------------------------------------ */

export async function processResponseTimeouts(now = new Date()) {
  const bookings = await Booking.find({
    'nannyResponses.outcome': 'pending',
    status: { $in: [BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING] },
  });

  const handled = [];
  for (const booking of bookings) {
    const pending = booking.nannyResponses.find((r) => r.outcome === 'pending');
    if (!pending || new Date(pending.expiresAt) > now) continue;

    // No response in time counts as a decline.
    pending.outcome = 'timed_out';
    pending.respondedAt = now;

    const isChange = pending.kind === 'booking_change';
    const nannyId = booking.nanny;

    if (isChange) {
      // The original booking survives; the family may now change nanny.
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

    if (nannyId) {
      const nanny = await User.findById(nannyId);
      await notifyUser(nanny, `⌛ You did not respond in time to Booking #${booking.bookingNumber}, so it has been passed to another nanny.

Responding quickly helps you get more bookings.`);
    }

    await notifyFamilyOfDecline(booking, isChange);
    handled.push(booking.bookingNumber);
  }
  return handled;
}

/* ------------------------------------------------------------------ *
 * 2. Service day lifecycle
 *    scheduled -> awaiting arrival (at start time)
 *    arrival confirmed -> awaiting end of service (at end time)
 * ------------------------------------------------------------------ */

export async function processServiceDayTransitions(now = new Date()) {
  const bookings = await Booking.find({
    status: { $in: [BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING] },
  }).populate('nanny family');

  const changed = [];
  for (const booking of bookings) {
    let dirty = false;

    for (const day of booking.serviceDays) {
      if (day.status === SERVICE_DAY_STATUS.SCHEDULED && new Date(day.startAt) <= now) {
        day.status = SERVICE_DAY_STATUS.AWAITING_ARRIVAL;
        dirty = true;

        if (booking.family) {
          await notifyUser(booking.family, `🔔 *Your service starts now*

Booking #${booking.bookingNumber} — ${prettyDate(day.date)}
⏰ ${timeRange(booking.startTime, booking.hoursPerDay)}

🔐 Your ARRIVAL verification code is *${day.arrivalOtp}*.

Please give this code to your nanny once she arrives so we can confirm her arrival.`);
        }
        if (booking.nanny) {
          await notifyUser(booking.nanny, `🔔 *Your service starts now*

Booking #${booking.bookingNumber} — ${prettyDate(day.date)}
📍 ${booking.address?.addressLine || ''}

When you arrive, ask the family for the ARRIVAL code and confirm it from *My Bookings > Ongoing*.`);
        }
      }

      if (day.status === SERVICE_DAY_STATUS.ARRIVAL_CONFIRMED && new Date(day.endAt) <= now) {
        day.status = SERVICE_DAY_STATUS.AWAITING_END_OF_SERVICE;
        dirty = true;

        if (booking.family) {
          await notifyUser(booking.family, `Your service has ended. It's time for the nanny to leave.

🔐 Your END-OF-SERVICE verification code is *${day.endOtp}*.

Please give this code to your nanny so we can confirm her service has ended.`);
        }
        if (booking.nanny) {
          await notifyUser(booking.nanny, `⏰ Today's service time has ended for Booking #${booking.bookingNumber}.

Please ask the family for the END-OF-SERVICE code and confirm it from *My Bookings > Ongoing*.`);
        }
      }
    }

    if (dirty) {
      booking.markModified('serviceDays');
      syncBookingStatus(booking);
      await booking.save();
      changed.push(booking.bookingNumber);
    }
  }
  return changed;
}

/* ------------------------------------------------------------------ *
 * 3. Replacement reminders and auto-cancel
 *    Spec: remind the family; if the next service starts with no replacement
 *    selected, cancel the remaining booking and refund unused services.
 * ------------------------------------------------------------------ */

export async function processReplacementDeadlines(now = new Date()) {
  const bookings = await Booking.find({
    subStatus: BOOKING_SUBSTATUS.NANNY_CANCELLED_AWAITING_REPLACEMENT,
    status: { $in: [BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING] },
    nanny: { $exists: false },
  }).populate('family');

  const results = [];
  for (const booking of bookings) {
    const next = booking.remainingDays()[0];
    if (!next) continue;

    const startAt = new Date(next.startAt);

    // Past the start of the next service with nobody assigned -> cancel.
    if (startAt <= now) {
      const breakdown = await cancelBooking(booking, {
        cancelledBy: CANCELLED_BY.SYSTEM,
        reason: 'No replacement nanny selected before the next service',
        at: now,
      });
      if (breakdown.totalRefund > 0) {
        await refundBooking(booking, {
          amount: breakdown.totalRefund, breakdown,
          reason: 'No replacement selected',
        });
      }
      await notifyUser(booking.family, `🔴 *Booking Cancelled – No Replacement Selected*

Your nanny was unavailable and no replacement was selected before the next service started.

💰 A refund of *${money(breakdown.totalRefund)}* for all unused services will be processed.`);
      results.push({ booking: booking.bookingNumber, action: 'cancelled' });
      continue;
    }

    // Remind once a day while a replacement is still outstanding.
    const hoursLeft = (startAt - now) / 36e5;
    if (hoursLeft <= 24 && !booking.pendingChange?.reminderSent) {
      await notifyUser(booking.family, `🔔 Reminder: Your nanny cancelled your booking. Please select a replacement nanny before your next service starts on ${prettyDate(next.date)}.

Go to *My Bookings > Upcoming* to choose a replacement.`);
      booking.pendingChange = { ...(booking.pendingChange || {}), reminderSent: true };
      await booking.save();
      results.push({ booking: booking.bookingNumber, action: 'reminded' });
    }
  }
  return results;
}

/* ------------------------------------------------------------------ *
 * 4. Upcoming-service reminders (24h and 2h before)
 * ------------------------------------------------------------------ */

export async function processReminders(now = new Date()) {
  const horizon = dayjs(now).add(25, 'hour').toDate();
  const bookings = await Booking.find({
    status: { $in: [BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING] },
    subStatus: BOOKING_SUBSTATUS.NANNY_CONFIRMED,
    'serviceDays.startAt': { $gte: now, $lte: horizon },
  }).populate('family nanny');

  const sent = [];
  for (const booking of bookings) {
    for (const day of booking.serviceDays) {
      if (day.status !== SERVICE_DAY_STATUS.SCHEDULED) continue;
      const hoursUntil = (new Date(day.startAt) - now) / 36e5;

      // Live location becomes available 2 hours before the service.
      if (hoursUntil > 1.9 && hoursUntil <= 2.1 && booking.family) {
        await notifyUser(booking.family, `📍 Your service starts in *2 hours*.

You can now share your live location with your nanny from *My Bookings*.`);
        sent.push(booking.bookingNumber);
      }
    }
  }
  return sent;
}

/* ------------------------------------------------------------------ *
 * 5. Monday payouts
 * ------------------------------------------------------------------ */

export async function processPayouts(now = new Date()) {
  const released = await releaseDuePayouts(now);
  for (const payout of released) {
    const nanny = await User.findById(payout.nanny);
    if (!nanny) continue;
    await notifyUser(nanny, `💰 *Payment Released*

${money(payout.amount)} has been released to you.

Reference: ${payout.reference}
${payout.isFinalForBooking ? '\n✅ This completes the payment for that booking.' : ''}`);
  }
  return released;
}

/**
 * Wire 5 — the referral window sweep.
 *
 * A 30-day window can lapse while nothing at all is happening: they clicked,
 * they replied, and then they never booked. No message arrives, no payment is
 * verified, so nothing else in the system would ever notice. Without this
 * every referral figure quietly overstates what is still live.
 *
 * Read-only apart from two state flips, and it never touches money.
 */
export async function processReferralWindows() {
  const { expireStale } = await import('../services/referralAttribution.js');
  const { expireLinks } = await import('../services/shareLink.js');

  const [attributions, links] = await Promise.all([
    expireStale(),
    expireLinks(),
  ]);

  if (attributions || links) {
    console.log(`[referral] expired ${attributions} attribution(s), ${links} link(s)`);
  }
  return { attributions, links };
}

/**
 * The abuse sweep (OR9). Slower than the expiry pass on purpose — the
 * detectors aggregate over the whole click stream, and nothing they find
 * needs acting on within the hour.
 */
export async function processReferralAbuse() {
  const { runAbuseSweep } = await import('../services/linkAbuseDetector.js');
  const results = await runAbuseSweep();
  const raised = Object.values(results).reduce((s, n) => s + (n || 0), 0);
  if (raised) console.log('[referral] abuse sweep raised', raised, 'alert(s)');
  return results;
}

/* ------------------------------------------------------------------ *
 * Cron wiring
 * ------------------------------------------------------------------ */

let tasks = [];

export function startScheduler() {
  stopScheduler();

  // Every minute: response timeouts and service day transitions.
  tasks.push(cron.schedule('* * * * *', () => guard('responseTimeouts', processResponseTimeouts)));
  tasks.push(cron.schedule('* * * * *', () => guard('serviceDays', processServiceDayTransitions)));

  // Every 15 minutes: replacement deadlines and reminders.
  tasks.push(cron.schedule('*/15 * * * *', () => guard('replacements', processReplacementDeadlines)));
  tasks.push(cron.schedule('*/15 * * * *', () => guard('reminders', processReminders)));

  // Mondays at 09:00: release nanny payouts.
  tasks.push(cron.schedule('0 9 * * 1', () => guard('payouts', processPayouts)));

  // Hourly: expire lapsed referral windows and dead links, so reports stop
  // counting claims that can no longer be earned.
  tasks.push(cron.schedule('0 * * * *', () => guard('referralWindows', processReferralWindows)));

  // Twice a day: look for referral patterns worth a human review. Nothing
  // here blocks anyone — it raises an alert and a person decides.
  tasks.push(cron.schedule('0 3,15 * * *', () => guard('referralAbuse', processReferralAbuse)));

  console.log('[scheduler] started (7 jobs)');
  return tasks;
}

export function stopScheduler() {
  tasks.forEach((t) => t.stop());
  tasks = [];
}

/** Never let a job crash the process. */
async function guard(name, fn) {
  try {
    await fn(new Date());
  } catch (err) {
    console.error(`[scheduler:${name}] ${err.message}`);
  }
}

export default {
  startScheduler, stopScheduler, processResponseTimeouts,
  processServiceDayTransitions, processReplacementDeadlines,
  processReminders, processPayouts,
};
