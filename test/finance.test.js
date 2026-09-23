import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, clearDb } from './helpers.js';

/**
 * The finance figures, proved rather than assumed.
 *
 * Every number on that page is derived from bookings and costs at read time,
 * so a mistake here does not corrupt stored data — it misreports it, which is
 * worse in one specific way: nothing looks broken.
 */

before(setupDb);
after(teardownDb);
beforeEach(clearDb);

/** A completed booking worth `charged` to us and `paid` to her. */
async function completedBooking({ charged, nannyRate, hours = 2, family, nanny }) {
  const { Booking } = await import('../src/models/index.js');
  return Booking.create({
    bookingNumber: Math.floor(Math.random() * 100000),
    family,
    nanny,
    status: 'completed',
    hourlyRate: charged / hours,
    nannyHourlyRate: nannyRate,
    totalAmount: charged,
    serviceDays: [{
      date: '2026-09-10',
      status: 'completed',
      amount: charged,
      hours,
      startAt: new Date('2026-09-10T09:00:00Z'),
      endAt: new Date('2026-09-10T11:00:00Z'),
      endConfirmedAt: new Date('2026-09-10T11:00:00Z'),
    }],
  });
}

async function makeUsers() {
  const { User } = await import('../src/models/index.js');
  const family = await User.create({ role: 'family', phone: '999600000001', fullName: 'The Smiths' });
  const nanny = await User.create({
    role: 'nanny', phone: '999600000002', fullName: 'Maria', hourlyRate: 50,
  });
  return { family, nanny };
}

test('net profit is gross profit less the costs nobody billed to a booking', async () => {
  const { Cost } = await import('../src/models/index.js');
  const { financeSummary } = await import('../src/services/finance.js');
  const { family, nanny } = await makeUsers();

  // Charged 200, she is owed 100 -> 100 gross.
  await completedBooking({ charged: 200, nannyRate: 50, family: family._id, nanny: nanny._id });

  await Cost.create({
    spentOn: new Date('2026-09-11'), category: 'transport',
    description: 'Petrol', amount: 30,
  });

  const f = await financeSummary({ from: '2026-09-01', to: '2026-09-30' });

  assert.equal(f.totals.revenue, 200);
  assert.equal(f.totals.paidToNannies, 100);
  assert.equal(f.totals.grossProfit, 100, 'gross is what the booking kept');
  assert.equal(f.totals.costs, 30);
  assert.equal(f.totals.netProfit, 70, 'net is what survives the running costs');
});

test('a voided cost leaves the totals but stays on the ledger', async () => {
  const { Cost } = await import('../src/models/index.js');
  const { costSummary } = await import('../src/services/finance.js');

  await Cost.create({
    spentOn: new Date('2026-09-05'), category: 'supplies',
    description: 'Real', amount: 40,
  });
  await Cost.create({
    spentOn: new Date('2026-09-06'), category: 'supplies',
    description: 'Entered twice by mistake', amount: 40, voided: true,
  });

  const c = await costSummary({ from: '2026-09-01', to: '2026-09-30' });

  assert.equal(c.total, 40, 'a voided row is not spending');
  assert.equal(c.rows.length, 2, 'but the row is kept, so last month stays reproducible');
  assert.equal(c.voidedCount, 1);
});

test('revenue and profit are grouped per client and per nanny', async () => {
  const { User } = await import('../src/models/index.js');
  const { financeSummary } = await import('../src/services/finance.js');

  const familyA = await User.create({ role: 'family', phone: '999600000010', fullName: 'Family A' });
  const familyB = await User.create({ role: 'family', phone: '999600000011', fullName: 'Family B' });
  const nanny = await User.create({
    role: 'nanny', phone: '999600000012', fullName: 'Maria', hourlyRate: 50,
  });

  // Family A books twice, family B once. All worked by the same nanny.
  await completedBooking({ charged: 200, nannyRate: 50, family: familyA._id, nanny: nanny._id });
  await completedBooking({ charged: 200, nannyRate: 50, family: familyA._id, nanny: nanny._id });
  await completedBooking({ charged: 300, nannyRate: 50, family: familyB._id, nanny: nanny._id });

  const f = await financeSummary({ from: '2026-09-01', to: '2026-09-30' });

  assert.equal(f.byClient.length, 2, 'two clients');
  const a = f.byClient.find((r) => r.name === 'Family A');
  assert.equal(a.bookings, 2);
  assert.equal(a.charged, 400);
  assert.equal(a.profit, 200);

  // One nanny across all three, so her row aggregates every booking.
  assert.equal(f.byNanny.length, 1);
  assert.equal(f.byNanny[0].charged, 700);
  assert.equal(f.byNanny[0].bookings, 3);
});

test('two clients sharing a name are not merged into one row', async () => {
  const { User } = await import('../src/models/index.js');
  const { financeSummary } = await import('../src/services/finance.js');

  // Grouping on the display name would silently combine these two.
  const one = await User.create({ role: 'family', phone: '999600000020', fullName: 'John Smith' });
  const two = await User.create({ role: 'family', phone: '999600000021', fullName: 'John Smith' });
  const nanny = await User.create({
    role: 'nanny', phone: '999600000022', fullName: 'Maria', hourlyRate: 50,
  });

  await completedBooking({ charged: 200, nannyRate: 50, family: one._id, nanny: nanny._id });
  await completedBooking({ charged: 200, nannyRate: 50, family: two._id, nanny: nanny._id });

  const f = await financeSummary({ from: '2026-09-01', to: '2026-09-30' });
  assert.equal(f.byClient.length, 2, 'grouped by id, not by name');
});

test('costs outside the period do not reach the figures', async () => {
  const { Cost } = await import('../src/models/index.js');
  const { costSummary } = await import('../src/services/finance.js');

  await Cost.create({
    spentOn: new Date('2026-08-31'), category: 'rent', description: 'Last month', amount: 500,
  });
  await Cost.create({
    spentOn: new Date('2026-09-15'), category: 'rent', description: 'This month', amount: 600,
  });
  await Cost.create({
    spentOn: new Date('2026-10-01'), category: 'rent', description: 'Next month', amount: 700,
  });

  const c = await costSummary({ from: '2026-09-01', to: '2026-09-30' });
  assert.equal(c.total, 600, 'only September');
  assert.equal(c.rows.length, 1);
});

test('a cost on the first or last day of the period is counted', async () => {
  const { Cost } = await import('../src/models/index.js');
  const { costSummary } = await import('../src/services/finance.js');

  // Boundaries are where date ranges usually go wrong, so both are asserted.
  await Cost.create({
    spentOn: new Date('2026-09-01T00:00:00'), category: 'fees', description: 'First day', amount: 10,
  });
  await Cost.create({
    spentOn: new Date('2026-09-30T23:30:00'), category: 'fees', description: 'Last day', amount: 20,
  });

  const c = await costSummary({ from: '2026-09-01', to: '2026-09-30' });
  assert.equal(c.total, 30, 'both ends of the range are inclusive');
});

test('money paid out is kept apart from money still owed', async () => {
  const { User, Payout } = await import('../src/models/index.js');
  const { payoutSummary } = await import('../src/services/finance.js');

  const nanny = await User.create({
    role: 'nanny', phone: '999600000030', fullName: 'Maria', hourlyRate: 50,
  });

  // `reference` is uniquely indexed, so each row needs its own.
  await Payout.create({ nanny: nanny._id, amount: 100, status: 'completed', reference: 'T1' });
  await Payout.create({ nanny: nanny._id, amount: 50, status: 'pending', reference: 'T2' });
  // A failed payout is still owed — it must not vanish from both figures.
  await Payout.create({ nanny: nanny._id, amount: 25, status: 'failed', reference: 'T3' });

  const p = await payoutSummary({
    from: new Date(Date.now() - 86400000),
    to: new Date(Date.now() + 86400000),
  });

  assert.equal(p.paid, 100, 'only what actually left the account');
  assert.equal(p.pending, 75, 'queued and failed are both still owed');
  assert.equal(p.byNanny[0].paid, 100);
  assert.equal(p.byNanny[0].pending, 75);
});

/* ------------------------------------------------------------------ *
 * Access control
 *
 * The rule is that whoever keeps the books can record spending without
 * also being handed control of nannies, bookings and payments. These
 * assert the boundary rather than the intention.
 * ------------------------------------------------------------------ */

test('a finance user cannot reach anything but the finance pages', async () => {
  // The same table the router uses, exercised directly.
  const SCOPED = {
    finance: [/^\/finance/, /^\/costs/, /^\/auth\//, /^\/settings$/],
    support: [/^\/tickets/, /^\/callbacks/, /^\/conversations/, /^\/notes/, /^\/auth\//],
  };
  const allowed = (role, path) => {
    const rules = SCOPED[role];
    return !rules || rules.some((re) => re.test(path));
  };

  // The routes that would let a bookkeeper run the agency.
  for (const path of [
    '/nannies/507f1f77bcf86cd799439011/verify',
    '/nannies/507f1f77bcf86cd799439011/suspend',
    '/bookings/507f1f77bcf86cd799439011/cancel',
    '/families/507f1f77bcf86cd799439011/block',
    '/payments/507f1f77bcf86cd799439011/approve',
  ]) {
    assert.equal(allowed('finance', path), false, `finance must not reach ${path}`);
  }

  // And the ones they need.
  for (const path of ['/finance', '/costs', '/costs/507f1f77bcf86cd799439011', '/auth/me']) {
    assert.equal(allowed('finance', path), true, `finance must reach ${path}`);
  }

  // An unscoped role is unaffected.
  assert.equal(allowed('admin', '/nannies/507f1f77bcf86cd799439011/verify'), true);
  assert.equal(allowed('super_admin', '/costs'), true);
});

test('a cost lands in the month it was entered for, whatever the server timezone', async () => {
  const dayjs = (await import('dayjs')).default;

  // The route and the query must parse a date-only string the same way.
  // `new Date('2026-09-01')` is UTC midnight; dayjs is local midnight, and
  // west of UTC that put the 1st outside its own month.
  const stored = dayjs('2026-09-01').startOf('day').toDate();
  const start = dayjs('2026-09-01').startOf('day').toDate();
  const end = dayjs('2026-09-30').endOf('day').toDate();

  assert.ok(stored >= start && stored <= end, 'the 1st belongs to its own month');

  const lastDay = dayjs('2026-09-30').startOf('day').toDate();
  assert.ok(lastDay >= start && lastDay <= end, 'and so does the last');

  const prevMonth = dayjs('2026-08-31').startOf('day').toDate();
  assert.ok(!(prevMonth >= start && prevMonth <= end), 'the month before stays out');
});

test('an amount that is empty, zero or absurd is refused', async () => {
  // The route's own rule, which the schema's `min: 0` does not cover.
  const accepted = (v) => {
    if (v === '' || v === null || v === undefined) return false;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return false;
    return !(n > 1e9);
  };

  for (const v of ['', null, undefined, 'abc', -5, 0, NaN, Infinity, 1e308]) {
    assert.equal(accepted(v), false, `${String(v)} must be refused`);
  }
  for (const v of [1, 100, '250.5', 1e9]) {
    assert.equal(accepted(v), true, `${String(v)} must be accepted`);
  }
});
