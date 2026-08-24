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

test('completed days are never refunded and always pay the nanny', () => {
  const now = new Date('2026-08-10T00:00:00Z');
  const booking = {
    serviceDays: [
      { _id: 'a', date: '2026-08-01', startAt: '2026-08-01T09:00:00Z', amount: 50, status: 'completed' },
      { _id: 'b', date: '2026-08-20', startAt: '2026-08-20T09:00:00Z', amount: 50, status: 'scheduled' },
    ],
  };
  const r = computeCancellationRefund(booking, { cancelledBy: CANCELLED_BY.FAMILY, at: now });
  // 10 days notice on day b => 100% refund; day a completed => nanny keeps it.
  assert.equal(r.totalRefund, 50);
  assert.equal(r.completedAmount, 50);
  assert.equal(r.totalNannyCompensation, 50);
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
