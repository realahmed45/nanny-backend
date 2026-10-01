import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { Payment, Payout } from '../models/Payment.js';
import { nextSequence } from '../models/Counter.js';
import { Booking, User } from '../models/index.js';
import { PAYMENT_STATUS, PAYOUT_STATUS, BOOKING_STATUS, SERVICE_DAY_STATUS } from '../utils/constants.js';
import { round2 } from './policy.js';
import config from '../config/index.js';

/**
 * Money is moved by manual bank transfer, outside this system.
 *
 * The family transfers the amount and uploads a screenshot of the receipt; an
 * admin checks it against the bank and approves or rejects it. Nothing here
 * talks to a payment gateway — these functions only keep the record straight,
 * so what the dashboard shows always matches what a human actually verified.
 *
 * The lifecycle of a payment is therefore:
 *   IN_PROCESS  — proof uploaded, waiting for an admin
 *   COMPLETED   — admin confirmed the transfer landed
 *   FAILED      — admin rejected it (wrong amount, unreadable, not received)
 *
 * and for refunds:
 *   REFUND_IN_PROCESS — owed to the family, admin still has to send it
 *   REFUNDED          — admin sent it and recorded the proof
 */

dayjs.extend(utc);
dayjs.extend(timezone);

async function reference(prefix) {
  return `${prefix}-${await nextSequence('payment_doc', 50000)}`;
}

/**
 * Record a family's transfer for a booking (or an additional top-up) and put it
 * in the admin review queue. `proof` is the screenshot the family uploaded.
 */
export async function recordTransfer(booking, { amount = null, kind = 'booking', proof = {} } = {}) {
  const value = round2(amount ?? booking.totalAmount);

  const payment = await Payment.create({
    reference: await reference(kind === 'additional' ? 'ADD' : 'PAY'),
    booking: booking._id,
    family: booking.family,
    kind,
    method: 'bank_transfer',
    amount: value,
    currency: config.currency,
    status: PAYMENT_STATUS.IN_PROCESS,
    proof: {
      url: proof.url,
      mediaId: proof.mediaId,
      uploadedAt: new Date(),
      note: proof.note,
    },
  });

  booking.paymentStatus = PAYMENT_STATUS.IN_PROCESS;
  await booking.save();

  return { success: true, payment };
}

/**
 * An admin confirmed the transfer arrived. This is the only path that marks a
 * booking paid, so the money in the dashboard always reflects a human check.
 */
export async function approveTransfer(payment, { adminId = null, note = '' } = {}) {
  if (payment.status === PAYMENT_STATUS.COMPLETED) {
    return { success: true, payment, alreadyApproved: true };
  }

  payment.status = PAYMENT_STATUS.COMPLETED;
  payment.reviewedBy = adminId;
  payment.reviewedAt = new Date();
  payment.reviewNote = note;
  payment.processedAt = new Date();
  await payment.save();

  const booking = await Booking.findById(payment.booking);
  if (booking) {
    booking.paidAmount = round2((booking.paidAmount || 0) + (payment.amount || 0));
    booking.paymentStatus = PAYMENT_STATUS.COMPLETED;
    if (payment.kind === 'additional') {
      // `totalAmount` is NOT increased here.
      //
      // A top-up only ever arises from a reschedule, and `applyPendingChange`
      // has already recalculated the booking to its new total — the top-up is
      // the difference it asked the family to pay, not an extra charge on top
      // of it. Adding it again inflated every rescheduled booking by the
      // difference, so the invoice and the rate card disagreed forever after.
      //
      // Only the outstanding balance is cleared.
      booking.additionalDue = 0;

      // A reschedule penalty inside the top-up is now money received: it is
      // recorded as revenue on the day it was paid. It never reached any
      // revenue figure before, because it is not part of any day's price.
      if ((booking.reschedulePenaltyDue || 0) > 0) {
        booking.reschedulePenalties.push({ amount: booking.reschedulePenaltyDue, paidAt: new Date() });
        booking.reschedulePenaltyDue = 0;
      }

      // Paid up, so the booking stops asking for it. The status used to stay
      // "pending additional payment" and offer "Pay Now" for Rp 0.
      if (booking.status === BOOKING_STATUS.PENDING_ADDITIONAL_PAYMENT) {
        const { restingStatus } = await import('./booking.js');
        booking.status = restingStatus(booking);
      }
    }
    await booking.save();
  }

  // A receipt for this order, emailed the moment it is paid.
  //
  // Separate from the nightly file on purpose: that one is a safety net for
  // the whole business, this is a per-transaction trail that lands while the
  // order is fresh. Never allowed to fail the payment — the money has already
  // been approved, and a bookkeeping email must not undo that.
  if (booking) {
    try {
      const { sendOrderBackup } = await import('./backup.js');
      await sendOrderBackup(booking);
    } catch (err) {
      console.error(`[backup] order receipt for ${booking.bookingNumber} failed: ${err.message}`);
    }
  }

  // Wire 4 of the referral engine — OR10.
  //
  // Here rather than at booking creation, because a booking is created unpaid
  // and verified by a person later. Freezing on creation would settle
  // attribution on bookings that were never paid, and could be used to lock a
  // rival's referral out of a claim it had legitimately won.
  //
  // Safe to run more than once: this function returns early on an already
  // approved payment, and the conversion is keyed on the booking anyway.
  if (booking) {
    try {
      const { User } = await import('../models/index.js');
      const family = await User.findById(booking.family);
      if (family) {
        const { resolveOnBooking } = await import('./referralAttribution.js');
        const result = await resolveOnBooking(family, booking);

        // OR3's cost, surfaced before anyone has to ask: a referrer swapped
        // just before this booking means someone lost a claim they earned,
        // and split credit is not an option here.
        if (result.changed) {
          const { checkCreditSniping } = await import('./linkAbuseDetector.js');
          await checkCreditSniping(family, booking).catch(() => {});
        }
      }
    } catch (err) {
      // Attribution must never block a verified payment.
      console.error('[referral] could not settle attribution:', err.message);
    }
  }

  return { success: true, payment, booking };
}

/** An admin rejected the proof — the family has to transfer again. */
export async function rejectTransfer(payment, { adminId = null, note = '' } = {}) {
  payment.status = PAYMENT_STATUS.FAILED;
  payment.reviewedBy = adminId;
  payment.reviewedAt = new Date();
  payment.reviewNote = note;
  payment.failureReason = note || 'Transfer could not be verified';
  await payment.save();

  const booking = await Booking.findById(payment.booking);
  if (booking) {
    booking.paymentStatus = PAYMENT_STATUS.FAILED;
    await booking.save();
  }

  return { success: true, payment, booking };
}

/**
 * Record that a refund is owed. No money moves here — an admin transfers it
 * manually and then calls `completeRefund` with the proof.
 */
export async function refundBooking(booking, {
  amount, breakdown = null, reason = '', category = null,
} = {}) {
  const value = round2(amount);
  // `NaN <= 0` is false, so a non-numeric amount used to sail past this and
  // be written as a refund of NaN. Nothing to refund is still a success.
  if (!Number.isFinite(value) || value <= 0) return { success: true, payment: null, amount: 0 };

  const payment = await Payment.create({
    reference: await reference('RFD'),
    booking: booking._id,
    family: booking.family,
    kind: 'refund',
    method: 'bank_transfer',
    amount: value,
    currency: config.currency,
    status: PAYMENT_STATUS.REFUND_IN_PROCESS,
    breakdown,
    reviewNote: reason,
    // What the refund is for. Cancellation and reschedule refunds return money
    // for days that were never counted as revenue; only a manual refund (a
    // goodwill gesture on work that was done) reduces profit.
    refundCategory: category || (breakdown ? 'cancellation' : 'manual'),
  });

  booking.paymentStatus = PAYMENT_STATUS.REFUND_IN_PROCESS;
  await booking.save();

  return { success: true, payment, amount: value };
}

/** An admin sent the refund by transfer and attached the receipt. */
export async function completeRefund(payment, { adminId = null, proof = {}, note = '' } = {}) {
  /**
   * Claim the refund with the status change itself.
   *
   * Every other money action refuses to run twice; this one did not, so a
   * double click — or two admins on the same row — added the amount to the
   * booking's `refundedAmount` twice and drove its profit negative. Only the
   * request that still finds it in process gets to move it.
   */
  const now = new Date();
  const claimed = await Payment.findOneAndUpdate(
    { _id: payment._id, kind: 'refund', status: PAYMENT_STATUS.REFUND_IN_PROCESS },
    {
      $set: {
        status: PAYMENT_STATUS.REFUNDED,
        reviewedBy: adminId,
        reviewedAt: now,
        processedAt: now,
        ...(note ? { reviewNote: note } : {}),
        refundProof: {
          url: proof.url,
          mediaId: proof.mediaId,
          uploadedAt: proof.url ? now : undefined,
        },
      },
    },
    { new: true },
  );

  if (!claimed) {
    return { success: false, alreadyDone: true, payment, booking: null };
  }
  payment = claimed;

  const booking = await Booking.findById(payment.booking);
  if (booking) {
    booking.refundedAmount = round2((booking.refundedAmount || 0) + (payment.amount || 0));
    booking.paymentStatus = PAYMENT_STATUS.REFUNDED;
    await booking.save();
  }

  return { success: true, alreadyDone: false, payment, booking };
}

/**
 * The next Monday strictly after a date — payouts are released weekly.
 *
 * Strictly after, not "on or after". The loop used to check the day before
 * advancing, so work finished on a Monday was scheduled for that same Monday
 * at 00:00 — a time already past, which the release sweep reads as due and
 * pays out immediately. Monday's work skipped the weekly hold entirely while
 * Tuesday's waited the full six days.
 */
export function nextMonday(from = new Date()) {
  // On Bali's calendar, not the server's. The server runs UTC, so work
  // finished on a Monday between midnight and 8am Bali time was still
  // "Sunday" here, got scheduled for that same Monday, and skipped the hold.
  let d = dayjs(from).tz(config.timezone).startOf('day').add(1, 'day');
  while (d.day() !== 1) d = d.add(1, 'day');
  return d.toDate();
}

/**
 * Queue a nanny payout for completed service day(s).
 * Called when a service day completes, or when a cancellation leaves the nanny
 * with compensation.
 */
export async function queuePayout(booking, {
  nannyId, amount, serviceDayIds = [], isFinal = false, notes = '', overtime = null,
}) {
  const value = round2(amount);
  // A payout the overtime commission took to zero is still written: it is the
  // record that the commission was collected.
  if (!(value > 0) && !(overtime?.commissionDeducted > 0)) return null;

  return Payout.create({
    reference: await reference('PYT'),
    nanny: nannyId || booking.nanny,
    booking: booking._id,
    serviceDayIds: serviceDayIds.map(String),
    amount: Math.max(0, value),
    currency: config.currency,
    // Nothing left to send once the commission is taken: settled on the spot,
    // so nobody has to "transfer" Rp 0 and upload a receipt for it.
    status: value > 0 ? PAYOUT_STATUS.PENDING : PAYOUT_STATUS.COMPLETED,
    ...(value > 0 ? {} : { releasedAt: new Date() }),
    scheduledFor: nextMonday(),
    isFinalForBooking: isFinal,
    notes,
    ...(overtime ? { overtime } : {}),
  });
}

/**
 * The Monday job moves due payouts into "processing" — an admin then transfers
 * each one by hand and marks it released. Nothing is auto-completed, because no
 * money can move without a person doing it.
 */
export async function releaseDuePayouts(now = new Date()) {
  const due = await Payout.find({
    status: PAYOUT_STATUS.PENDING,
    scheduledFor: { $lte: now },
  }).select('_id');

  const queued = [];
  for (const { _id } of due) {
    /**
     * Claimed with the status change itself.
     *
     * This used to load the payout and save it back as PROCESSING. If an admin
     * marked it paid in between, the save flipped a paid payout back to
     * "processing", and it could be paid — and an advance recovered from it —
     * a second time. Only a payout still PENDING moves.
     */
    // eslint-disable-next-line no-await-in-loop
    const p = await Payout.findOneAndUpdate(
      { _id, status: PAYOUT_STATUS.PENDING },
      { $set: { status: PAYOUT_STATUS.PROCESSING } },
      { new: true },
    );
    if (!p) continue;

    /**
     * Any advance comes off now, before anyone transfers anything.
     *
     * It used to come off when the payout was marked paid — after the admin had
     * already sent the full amount shown on screen. The system then recorded
     * the smaller figure and cleared the advance, so the nanny kept both: every
     * recovered advance was paid twice. Taken here, the amount in the queue is
     * the amount to send.
     */
    // eslint-disable-next-line no-await-in-loop
    await recoverAdvances(p, now);
    queued.push(p);
  }
  return queued;
}

/**
 * Statuses that mean the money has already gone out.
 *
 * Kept next to the recovery it guards: marking a settled payout paid again must
 * not move anything a second time.
 */
const SETTLED_PAYOUT = new Set([PAYOUT_STATUS.COMPLETED, PAYOUT_STATUS.FINAL_DONE]);

/**
 * Take back any advance this nanny still owes, out of a payout about to go.
 *
 * An advance is her own salary paid early, so it comes off the next wages
 * run rather than being chased separately. Oldest first, so the debt clears
 * in the order it was taken on.
 *
 * When an advance is larger than the payout it is recovered from, the payout
 * goes to zero and the rest stays outstanding for the next one — nothing is
 * clawed back from somebody who has already spent it.
 *
 * Returns what was recovered, so the caller can say so rather than leaving a
 * nanny to work out why her payment is smaller than she expected.
 */
async function recoverAdvances(payout, now = new Date()) {
  // An advance never pays for itself.
  if (payout.kind === 'advance') return { recovered: 0, from: [] };

  // Only advances due from this month or earlier. The nanny is told which
  // month's salary an advance comes off; it used to come off the very next
  // payout regardless, even one in the month before.
  const thisMonth = dayjs(now).tz(config.timezone).format('YYYY-MM');
  const open = (await Payout.find({
    nanny: payout.nanny,
    kind: 'advance',
    'advance.outstanding': { $gt: 0 },
  }).sort({ createdAt: 1 })).filter(
    (adv) => !adv.advance?.recoverFrom || adv.advance.recoverFrom <= thisMonth,
  );

  if (!open.length) return { recovered: 0, from: [] };

  let available = round2(payout.amount || 0);
  let recovered = 0;
  const from = [];

  for (const adv of open) {
    if (available <= 0) break;

    const owed = round2(adv.advance.outstanding);
    const take = Math.min(owed, available);

    /**
     * Claim the money with the subtraction itself, not with a later save.
     *
     * Reading the balance and then writing it back let two payouts settled at
     * the same moment both read 300,000, both subtract it, and both send her
     * 300,000 less — one advance recovered twice, and 300,000 of her wages
     * gone. The `$gte` makes the write conditional on the balance still being
     * there, so the second one matches nothing and takes nothing.
     */
    // eslint-disable-next-line no-await-in-loop
    const claimed = await Payout.findOneAndUpdate(
      { _id: adv._id, 'advance.outstanding': { $gte: take } },
      {
        $inc: { 'advance.outstanding': -take },
        ...(take >= owed ? { $set: { 'advance.recoveredAt': new Date() } } : {}),
      },
      { new: true },
    );

    // Somebody else got there first. Her debt is already smaller than we
    // thought, so there is nothing to take here and nothing to correct.
    if (!claimed) continue;

    available = round2(available - take);
    recovered = round2(recovered + take);
    from.push({ reference: adv.reference, amount: take });
  }

  if (recovered > 0) {
    // Written only while the payout is still waiting to be sent. If it was
    // marked paid meanwhile, the full amount has already gone out, so the
    // advances are handed back rather than recorded as recovered.
    const applied = await Payout.findOneAndUpdate(
      { _id: payout._id, status: { $in: [PAYOUT_STATUS.PENDING, PAYOUT_STATUS.PROCESSING] } },
      { $inc: { amount: -recovered, advanceRecovered: recovered } },
      { new: true },
    );
    if (!applied) {
      for (const f of from) {
        // eslint-disable-next-line no-await-in-loop
        await Payout.updateOne(
          { reference: f.reference },
          { $inc: { 'advance.outstanding': f.amount }, $unset: { 'advance.recoveredAt': 1 } },
        );
      }
      return { recovered: 0, from: [] };
    }
    payout.amount = applied.amount;
    payout.advanceRecovered = applied.advanceRecovered;
  }

  return { recovered, from };
}

/** An admin transferred a payout to the nanny and recorded the proof. */
export async function markPayoutPaid(payout, { adminId = null, proof = {}, note = '' } = {}) {
  /**
   * Already settled, so nothing moves again.
   *
   * Without this an admin double-clicking, or retrying a request that timed
   * out while the WhatsApp notice was sending, ran the recovery a second time
   * — and because the first advance was by then cleared, it took the money out
   * of whichever *other* advance she had open. `advanceRecovered` was assigned
   * rather than added to, so the record of the first recovery was overwritten
   * as well. Measured: a 1,000,000 payout paid her 500,000 instead of 700,000.
   */
  if (SETTLED_PAYOUT.has(payout.status)) {
    return { success: true, payout, advance: { recovered: 0, from: [] }, alreadyPaid: true };
  }

  /**
   * Claimed in one conditional write, so two clicks cannot both settle it.
   *
   * Nothing is recovered here any more. By the time a payout is marked paid
   * the admin has already transferred the amount on screen; advances come off
   * when the payout is released (`releaseDuePayouts`), so that amount is
   * already net. A payout paid early, before release, was paid in full and any
   * advance simply waits for the next one.
   */
  const now = new Date();
  const claimed = await Payout.findOneAndUpdate(
    { _id: payout._id, status: { $in: [PAYOUT_STATUS.PENDING, PAYOUT_STATUS.PROCESSING] } },
    {
      $set: {
        status: payout.isFinalForBooking ? PAYOUT_STATUS.FINAL_DONE : PAYOUT_STATUS.COMPLETED,
        releasedAt: now,
        releasedBy: adminId,
        ...(note ? { notes: note } : {}),
        proof: {
          url: proof.url,
          mediaId: proof.mediaId,
          uploadedAt: proof.url ? now : undefined,
        },
      },
    },
    { new: true },
  );

  if (!claimed) {
    const current = await Payout.findById(payout._id);
    return {
      success: true, payout: current || payout, advance: { recovered: 0, from: [] }, alreadyPaid: true,
    };
  }

  const advance = {
    recovered: claimed.advanceRecovered || 0,
    from: [],
  };
  return { success: true, payout: claimed, advance };
}

/**
 * Earnings owed to a nanny for one completed service day.
 *
 * Two completely separate numbers meet here, and confusing them is what made
 * this function wrong for so long:
 *
 *   day.amount     — what the FAMILY was charged. Comes from the platform's
 *                    rate card (children, holiday multiplier, discounts).
 *                    Nothing to do with the nanny.
 *   nannyHourlyRate — what SHE is paid. Her own asking rate, agreed with the
 *                    office when she registers. Admin-side only; a family
 *                    never sees it and it never affects what they pay.
 *
 * The difference between them is the platform's commission.
 *
 * This used to return `day.amount`, paying every nanny the entire sum the
 * family had paid and leaving the business with nothing on any booking.
 *
 * `nannyHourlyRate` is passed in rather than read here because the caller
 * already has the nanny loaded, and a stale rate must never be used: the rate
 * is captured onto the booking when it is created, so a later change to her
 * profile cannot retroactively alter what she is owed for work already done.
 *
 * Overtime is paid at the same hourly rate, using the rounded hours the policy
 * settled on (15 min becomes half an hour, 45 becomes a full one).
 */
export function dayEarnings(booking, day, nannyHourlyRate, { overtime = true } = {}) {
  const rate = Number(nannyHourlyRate ?? booking?.nannyHourlyRate ?? 0);

  // No agreed rate means we cannot say what she is owed. Falling back to the
  // family price is exactly the bug this replaced, and guessing a number is
  // worse than showing zero and having someone notice.
  if (!rate || rate <= 0) {
    console.error(
      `[payments] booking ${booking?.bookingNumber || booking?._id}: no nanny rate recorded; `
      + 'earnings for this day are 0 until an admin sets one',
    );
    return 0;
  }

  const hours = Number(day.hours ?? booking?.hoursPerDay ?? 0);
  const overtimeHours = overtime ? Number(day.overtimeHours || 0) : 0;

  return round2(rate * (hours + overtimeHours));
}

/**
 * Who worked a service day, and what each of them earned for it.
 *
 * The single answer used both to pay nannies and to count what was paid out,
 * so the payouts and the profit figures cannot tell different stories.
 *
 * A 24h booking with a second nanny is worked by both of them, each at her own
 * rate. Paying only `booking.nanny` meant the second nanny's pay was filed
 * against the first, and counting only one of them left the second nanny's
 * whole cost out of profit.
 *
 * Overtime belongs to the nanny who stayed on — the one who closed the day —
 * and is recorded on the day by `recordOvertime`. Each entry says:
 *   base         — her pay for the scheduled hours
 *   overtimePay  — her share of the overtime, at her own rate
 *   commission   — our cut of the overtime, which she owes us, because the
 *                  family paid the whole overtime amount to her directly
 */
export function dayWorkers(booking, day) {
  // The day's own stamp first, then whoever holds the booking, then the nanny
  // who left it: a worked day still cost her pay after she was cleared off.
  const first = day?.nanny || booking?.nanny || booking?.replacementOfNanny;
  const second = booking?.secondNanny?._id || booking?.secondNanny;
  const ids = [first, second].filter(Boolean).map((id) => String(id?._id || id));
  const unique = [...new Set(ids)];

  // Nobody recorded at all (old or hand-edited data). The day was still
  // worked and still paid for, so it is counted at the booking's own rate
  // rather than as pure commission.
  if (!unique.length) unique.push('');

  const closedBy = String(day?.overtimeNanny?._id || day?.overtimeNanny || unique[0] || '');

  /**
   * Two nannies share the day, so each is paid for her own shift.
   *
   * The family is charged for the day's hours once. Paying both nannies for
   * the whole of them (24h each on a 24h day) paid out more than the family
   * was charged on every day of every two-nanny booking. The owner's rule:
   * each nanny is paid for her half.
   */
  const share = unique.length > 1 ? 1 / unique.length : 1;
  const dayHours = Number(day?.hours ?? booking?.hoursPerDay ?? 0);
  const bonusTo = String(booking?.emergencyBonusNanny?._id || booking?.emergencyBonusNanny || '');

  return unique.map((nannyId) => {
    const rate = rateForDay(booking, day, nannyId);
    const shiftHours = dayHours * share;
    let base = dayEarnings(booking, { hours: shiftHours }, rate, { overtime: false });

    // The emergency bonus the broadcast promised, per hour she works.
    if (nannyId && nannyId === bonusTo && (booking.emergencyBonusHourly || 0) > 0) {
      base = round2(base + booking.emergencyBonusHourly * shiftHours);
    }
    const hasOvertime = nannyId === closedBy && (day?.overtimeHours || 0) > 0;

    // Days closed before overtime was split this way carry no nanny share (the
    // field reads as its default, 0), and we paid her the overtime ourselves:
    // her rate times the hours is what she was owed for them.
    const overtimePay = hasOvertime
      ? round2(day.overtimeCollectedByNanny
        ? (day.overtimeNannyPay || 0)
        : rate * (day.overtimeHours || 0))
      : 0;
    const commission = hasOvertime && day.overtimeCollectedByNanny
      ? round2(day.overtimeCommission || 0)
      : 0;

    return { nannyId, rate, base, overtimePay, commission };
  });
}

/**
 * What one nanny earns on a booking: her own rate, her own shifts, every day
 * that is not cancelled. The figure every nanny-facing message must show —
 * never the family's price, which revealed our commission and told her she
 * would be paid more than she is.
 */
export function nannyBookingPay(booking, nannyId) {
  const id = String(nannyId?._id || nannyId || '');
  const days = (booking?.serviceDays || []).filter((d) => d.status !== SERVICE_DAY_STATUS.CANCELLED);
  let total = 0;
  for (const d of days) {
    const mine = dayWorkers(booking, d).find((w) => w.nannyId === id);
    if (mine) total += mine.base;
  }
  return { rate: rateForDay(booking, null, id || null), total: round2(total) };
}

/**
 * Split an overtime amount between the nanny and us, and note it on the day.
 *
 * The family pays the whole overtime to the nanny in person, at the family
 * rate. Her share is her own rate times the hours; the rest is our commission,
 * which comes off her next payout (`takeOvertimeCommission`). Before this,
 * overtime was counted as revenue and paid to her again from our side, and the
 * family was never asked for it.
 */
export function recordOvertime(booking, day, nannyId, hours) {
  const nannyRate = rateForDay(booking, day, nannyId);
  const amount = round2(hours * (booking.hourlyRate || 0));
  const nannyPay = round2(Math.min(amount, hours * nannyRate));

  day.overtimeHours = hours;
  day.overtimeAmount = amount;
  day.overtimeNanny = nannyId;
  day.overtimeNannyPay = nannyPay;
  day.overtimeCommission = round2(amount - nannyPay);
  day.overtimeCollectedByNanny = true;
  return day;
}

/**
 * Take the overtime commission she owes out of a payout about to be queued.
 *
 * What she owes is kept as a running balance on her profile, so a commission
 * larger than the payout it arrives with is not lost: the payout goes to zero
 * and the rest waits for the next one. Both writes are conditional, so two
 * payouts queued at the same moment cannot take the same money twice.
 *
 * Returns how much was taken and how much is still owed afterwards.
 */
export async function takeOvertimeCommission(nannyId, { add = 0, available = 0 } = {}) {
  const owedNow = round2(add);
  if (owedNow > 0) {
    await User.updateOne({ _id: nannyId }, { $inc: { overtimeCommissionOwed: owedNow } });
  }

  const nanny = await User.findById(nannyId).select('overtimeCommissionOwed').lean();
  const owed = round2(nanny?.overtimeCommissionOwed || 0);
  const take = round2(Math.min(owed, Math.max(0, available)));

  if (take > 0) {
    const claimed = await User.findOneAndUpdate(
      { _id: nannyId, overtimeCommissionOwed: { $gte: take } },
      { $inc: { overtimeCommissionOwed: -take } },
      { new: true, projection: 'overtimeCommissionOwed' },
    );
    // Someone else took it first; her balance is already smaller.
    if (!claimed) return { taken: 0, stillOwed: owed };
    return { taken: take, stillOwed: round2(claimed.overtimeCommissionOwed || 0) };
  }

  return { taken: 0, stillOwed: owed };
}

/**
 * What the platform keeps on one completed day: the family price minus her pay.
 *
 * Kept next to `dayEarnings` so the two can never drift apart — the commission
 * is defined as the difference, not as its own rate, so it cannot disagree
 * with what was actually charged and actually paid.
 */
export function dayCommission(booking, day, nannyHourlyRate) {
  const charged = round2((day.amount || 0) + (day.overtimeAmount || 0));
  const paid = dayEarnings(booking, day, nannyHourlyRate);
  return round2(charged - paid);
}

/**
 * Which agreed rate applies to whoever actually worked this day.
 *
 * A booking can be worked by more than one person: the two nannies on a 24h
 * booking, or a replacement taking over mid-booking. Each service day records
 * who worked it, and they are not all on the same salary — so paying everyone
 * `booking.nannyHourlyRate` would quietly overpay some and underpay others.
 *
 * The day's own nanny wins when it is set, because it survives a replacement.
 * `secondNannyRate` is used when the day belongs to the second nanny, and the
 * primary rate is the fallback for everything else.
 */
export function rateForDay(booking, day, forNannyId = null) {
  const second = String(booking?.secondNanny?._id || booking?.secondNanny || '');

  /**
   * Who is being paid for this day.
   *
   * `day.nanny` is only stamped by a replacement — `buildServiceDays` never
   * sets it, and on a 24h booking both nannies cover the same days rather
   * than splitting them. So relying on `day.nanny` alone meant every day of
   * a two-nanny booking fell through to the primary rate, and the second
   * nanny was paid the first nanny's salary for the whole booking.
   *
   * `forNannyId` is what the caller knows and the day does not: which of the
   * two this payout is actually for. Falling back to the day's own stamp
   * keeps replacements working as before.
   */
  const worker = String(
    forNannyId?._id || forNannyId || day?.nanny?._id || day?.nanny || '',
  );

  if (worker && second && worker === second && booking.secondNannyHourlyRate) {
    return booking.secondNannyHourlyRate;
  }

  // The rate written on the day for the nanny who worked it — set when a
  // replacement took over — wins over the booking's current single rate.
  const stamped = String(day?.nanny?._id || day?.nanny || '');
  if (day?.nannyRate && (!worker || worker === stamped)) return day.nannyRate;
  return booking?.nannyHourlyRate || 0;
}

export default {
  recordTransfer, approveTransfer, rejectTransfer,
  refundBooking, completeRefund,
  queuePayout, releaseDuePayouts, markPayoutPaid,
  nextMonday, dayEarnings, dayCommission, rateForDay,
  dayWorkers, recordOvertime, takeOvertimeCommission,
};
