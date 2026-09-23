import test from 'node:test';
import assert from 'node:assert/strict';
import {
  singleDaySplit, multiDaySplit, computeCancellationRefund,
  computeOvertimeHours, computeBookingAmount,
} from '../src/services/policy.js';
import { CANCELLED_BY } from '../src/utils/constants.js';

test('single-day family cancellation bands match spec', () => {
  assert.equal(singleDaySplit(72).familyRefundPct, 100);
  assert.equal(singleDaySplit(48).familyRefundPct, 100);
  assert.equal(singleDaySplit(47).familyRefundPct, 50);
  assert.equal(singleDaySplit(36).familyRefundPct, 50);
  assert.equal(singleDaySplit(35).familyRefundPct, 0);
  assert.equal(singleDaySplit(1).nannyCompensationPct, 100);
});

test('multi-day family cancellation bands match spec', () => {
  assert.equal(multiDaySplit(6 * 24).familyRefundPct, 100);
  assert.equal(multiDaySplit(5 * 24).familyRefundPct, 100);
  assert.equal(multiDaySplit(4 * 24).familyRefundPct, 50);
  assert.equal(multiDaySplit(3 * 24).familyRefundPct, 25);
  assert.equal(multiDaySplit(2 * 24).familyRefundPct, 25);
  assert.equal(multiDaySplit(23).familyRefundPct, 0);
});

test('a completed day is not refunded, and is not paid a second time', () => {
  const now = new Date('2026-08-10T00:00:00Z');
  const booking = {
    serviceDays: [
      { _id: 'a', date: '2026-08-01', startAt: '2026-08-01T09:00:00Z', amount: 50, status: 'completed' },
      { _id: 'b', date: '2026-08-20', startAt: '2026-08-20T09:00:00Z', amount: 50, status: 'scheduled' },
    ],
  };
  const r = computeCancellationRefund(booking, { cancelledBy: CANCELLED_BY.FAMILY, at: now });

  // 10 days' notice on day b, so the family gets that day back in full.
  assert.equal(r.totalRefund, 50);

  // Day a is kept by the business rather than refunded.
  assert.equal(r.completedAmount, 50);

  /**
   * And it is owed to nobody here.
   *
   * The nanny was paid for day a the moment she completed it, at her own
   * rate. This used to report 50 — the family's price for a day already
   * settled — and every cancellation path paid it out again on top.
   */
  assert.equal(r.totalNannyCompensation, 0);
});

test('nanny cancellation refunds 100% of remaining days with no compensation', () => {
  const now = new Date('2026-08-19T23:00:00Z'); // 10 hours notice
  const booking = {
    serviceDays: [
      { _id: 'b', date: '2026-08-20', startAt: '2026-08-20T09:00:00Z', amount: 80, status: 'scheduled' },
    ],
  };
  const r = computeCancellationRefund(booking, { cancelledBy: CANCELLED_BY.NANNY, at: now });
  assert.equal(r.totalRefund, 80);
  assert.equal(r.totalNannyCompensation, 0);
});

test('overtime rounding: 15+ min = 30 min, 45+ min = 1 hour', () => {
  assert.equal(computeOvertimeHours(10), 0);
  assert.equal(computeOvertimeHours(15), 0.5);
  assert.equal(computeOvertimeHours(44), 0.5);
  assert.equal(computeOvertimeHours(45), 1);
  assert.equal(computeOvertimeHours(60), 1);
  assert.equal(computeOvertimeHours(75), 1.5);
  assert.equal(computeOvertimeHours(105), 2);
});

test('booking amount matches the spec example ($25/hr x 2hrs x 30 days = $1500)', () => {
  assert.equal(computeBookingAmount({ hourlyRate: 25, hoursPerDay: 2, days: 30 }), 1500);
});

/* ------------------------------------------------------------------ *
 * Regressions
 *
 * Each of these was a live bug. The assertions are the behaviour that was
 * wrong, so a reintroduction fails here rather than in somebody's payout.
 * ------------------------------------------------------------------ */

test('a reschedule past the free allowance actually charges the penalty', async () => {
  const { computeReschedulePenalty } = await import('../src/services/policy.js');
  const booking = {
    rescheduleCount: 5,          // well past the free limit
    serviceDays: [
      { _id: 'a', amount: 100, status: 'scheduled' },
      { _id: 'b', amount: 100, status: 'scheduled' },
    ],
  };

  // Called with the days it applies to, as the quoting screen does.
  const withDays = computeReschedulePenalty(booking, ['a', 'b']);
  assert.ok(withDays.penalty > 0, 'a penalty is owed once the free allowance is used up');

  // Called without them — the bug. The default empty list matched no days, so
  // the base was zero and the family was quoted a penalty then never charged.
  const withoutDays = computeReschedulePenalty(booking);
  assert.equal(withoutDays.penalty, 0);
  assert.notEqual(
    withDays.penalty, withoutDays.penalty,
    'the argument matters: omitting it silently zeroes the charge',
  );
});

test('a payout is never scheduled for a time that has already passed', async () => {
  const { nextMonday } = await import('../src/services/payments.js');

  // Every day of the week, including Monday itself — the case that broke.
  for (let i = 0; i < 7; i += 1) {
    const from = new Date(Date.UTC(2026, 8, 21 + i, 10, 0, 0));
    const due = nextMonday(from);
    assert.ok(
      due > from,
      `work finished ${from.toDateString()} must wait, not release immediately`,
    );
    assert.equal(due.getDay(), 1, 'payouts land on a Monday');
  }
});
