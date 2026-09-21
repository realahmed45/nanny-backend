import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The money split: what the family pays, what the nanny earns, what we keep.
 *
 * These are the numbers the business runs on, and they were wrong until
 * recently — every nanny was paid the entire amount the family had been
 * charged, so the platform earned nothing on any booking. That bug was
 * invisible because both figures were called "the amount". These tests exist
 * so it cannot come back quietly.
 *
 * No database: these are pure functions over plain objects, so they run in
 * milliseconds and cannot be broken by a fixture.
 */

const { dayEarnings, dayCommission, rateForDay } = await import('../src/services/payments.js');
const { bookingEarnings } = await import('../src/services/earnings.js');

const SERVICE_DAY_COMPLETED = 'completed';

/** A worked day: 4 hours, charged to the family at Rp 120,000/hr. */
const day = (over = {}) => ({
  date: '2026-09-01',
  hours: 4,
  amount: 480000,          // 4 hrs x Rp 120,000 — the FAMILY's price
  status: SERVICE_DAY_COMPLETED,
  overtimeHours: 0,
  overtimeAmount: 0,
  nannyCompensation: 0,
  ...over,
});

test('the nanny is paid her own rate, not the family price', () => {
  const booking = { bookingNumber: '1', nannyHourlyRate: 50000, hoursPerDay: 4 };

  // She is on Rp 50,000/hr, so four hours is Rp 200,000 — not the
  // Rp 480,000 the family paid.
  assert.equal(dayEarnings(booking, day(), 50000), 200000);
});

test('commission is what is left after paying her', () => {
  const booking = { bookingNumber: '1', nannyHourlyRate: 50000, hoursPerDay: 4 };

  // Rp 480,000 charged - Rp 200,000 paid = Rp 280,000 kept.
  assert.equal(dayCommission(booking, day(), 50000), 280000);
});

test('overtime is paid at her rate too, and still earns commission', () => {
  const booking = { bookingNumber: '1', nannyHourlyRate: 50000, hoursPerDay: 4 };
  const d = day({ overtimeHours: 1, overtimeAmount: 120000 });

  // 5 hours at her rate.
  assert.equal(dayEarnings(booking, d, 50000), 250000);
  // (480,000 + 120,000) charged - 250,000 paid.
  assert.equal(dayCommission(booking, d, 50000), 350000);
});

test('a booking with no recorded nanny rate pays nothing and says so', () => {
  const booking = { bookingNumber: '99', hoursPerDay: 4 };

  // Falling back to the family price is exactly the bug this replaced, and
  // inventing a rate would be worse. Zero is visible; a wrong number is not.
  assert.equal(dayEarnings(booking, day(), 0), 0);
  assert.equal(dayEarnings(booking, day(), undefined), 0);
});

test('a 24h booking pays each nanny her own rate', () => {
  const first = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const second = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const booking = {
    bookingNumber: '2',
    nanny: first,
    secondNanny: second,
    nannyHourlyRate: 50000,
    secondNannyHourlyRate: 65000,
    hoursPerDay: 4,
  };

  // The day belonging to the second nanny uses her rate, not the primary's.
  assert.equal(rateForDay(booking, day({ nanny: second })), 65000);
  assert.equal(dayEarnings(booking, day({ nanny: second }), rateForDay(booking, day({ nanny: second }))), 260000);

  // And the first nanny's day is unaffected.
  assert.equal(rateForDay(booking, day({ nanny: first })), 50000);
});

test('a replacement is paid the booking rate when she has no day of her own', () => {
  const booking = { bookingNumber: '3', nannyHourlyRate: 50000, hoursPerDay: 4 };
  // No `nanny` on the day and no second nanny: falls back to the primary rate
  // rather than to zero, so an ordinary single-nanny booking still pays.
  assert.equal(rateForDay(booking, day()), 50000);
});

test('bookingEarnings totals only completed days', () => {
  const booking = {
    _id: 'x', bookingNumber: '4', nannyHourlyRate: 50000, hoursPerDay: 4,
    refundedAmount: 0,
    serviceDays: [
      day(),
      day({ date: '2026-09-02' }),
      // Scheduled, not worked — must not count as revenue.
      day({ date: '2026-09-03', status: 'scheduled' }),
    ],
  };

  const money = bookingEarnings(booking);
  assert.equal(money.completedDays, 2);
  assert.equal(money.charged, 960000);        // 2 x 480,000
  assert.equal(money.paidToNannies, 400000);  // 2 x 200,000
  assert.equal(money.commission, 560000);
});

test('compensation for a cancelled day is money out, not commission', () => {
  const booking = {
    _id: 'x', bookingNumber: '5', nannyHourlyRate: 50000, hoursPerDay: 4,
    refundedAmount: 0,
    serviceDays: [
      day(),
      // Cancelled late: she is compensated although she did not work.
      day({ date: '2026-09-02', status: 'cancelled', nannyCompensation: 100000 }),
    ],
  };

  const money = bookingEarnings(booking);
  assert.equal(money.charged, 480000);
  assert.equal(money.paidToNannies, 300000);  // 200,000 worked + 100,000 compensation
  assert.equal(money.commission, 180000);
});

test('a refund comes out of what we kept', () => {
  const booking = {
    _id: 'x', bookingNumber: '6', nannyHourlyRate: 50000, hoursPerDay: 4,
    refundedAmount: 80000,
    serviceDays: [day()],
  };

  const money = bookingEarnings(booking);
  // 480,000 charged - 200,000 to her - 80,000 returned to the family.
  assert.equal(money.commission, 200000);
});

test('a booking missing its nanny rate is flagged, not silently zeroed', () => {
  const booking = {
    _id: 'x', bookingNumber: '7', hoursPerDay: 4, refundedAmount: 0,
    serviceDays: [day()],
  };

  const money = bookingEarnings(booking);
  assert.equal(money.missingNannyRate, true, 'someone has to notice this');
  // The whole family payment looks like commission, which is why it is flagged.
  assert.equal(money.paidToNannies, 0);
});
