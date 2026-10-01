import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, clearDb } from './helpers.js';

/**
 * Marking a payout paid must be safe to repeat.
 *
 * An admin double-clicks, or a request times out at the notification step and
 * is retried. Nothing about that should move money a second time.
 */

before(setupDb);
after(teardownDb);
beforeEach(clearDb);

async function nanny() {
  const { User } = await import('../src/models/index.js');
  return User.create({
    role: 'nanny', phone: '999900000009', fullName: 'Dewi', hourlyRate: 50000,
  });
}

const advance = async (n, amount, ref) => {
  const { Payout } = await import('../src/models/index.js');
  return Payout.create({
    reference: ref, nanny: n._id, kind: 'advance', amount,
    status: 'completed',
    advance: { outstanding: amount, recoverFrom: '2026-09' },
  });
};

const earnings = async (n, amount, ref) => {
  const { Payout } = await import('../src/models/index.js');
  // Due a week ago, so the Monday release picks it up.
  return Payout.create({
    reference: ref, nanny: n._id, amount, status: 'pending', scheduledFor: new Date('2026-09-21T00:00:00Z'),
  });
};

// A Monday in September, Bali time — the month the advances are due from.
const MONDAY = new Date('2026-09-28T02:00:00Z');

test('the advance comes off when the payout is released, before anyone transfers it', async () => {
  const { releaseDuePayouts, markPayoutPaid } = await import('../src/services/payments.js');
  const { Payout } = await import('../src/models/index.js');
  const n = await nanny();

  await advance(n, 300000, 'ADV-R0');
  await earnings(n, 1000000, 'PO-R0');

  await releaseDuePayouts(MONDAY);
  const queued = await Payout.findOne({ reference: 'PO-R0' });
  assert.equal(queued.amount, 700000, 'the queue shows the amount to actually send');
  assert.equal(queued.advanceRecovered, 300000);

  // Marking it paid moves nothing: the admin sent the 700,000 on screen.
  await markPayoutPaid(queued, { proof: { url: '/p.jpg' } });
  const paid = await Payout.findOne({ reference: 'PO-R0' });
  assert.equal(paid.amount, 700000);
  assert.equal(paid.status, 'completed');
});

test('marking the same payout paid twice does not move anything twice', async () => {
  const { releaseDuePayouts, markPayoutPaid } = await import('../src/services/payments.js');
  const { Payout } = await import('../src/models/index.js');
  const n = await nanny();

  await advance(n, 300000, 'ADV-R1');
  await earnings(n, 1000000, 'PO-R1');
  await releaseDuePayouts(MONDAY);

  const first = await Payout.findOne({ reference: 'PO-R1' });
  const one = await markPayoutPaid(first, { proof: { url: '/p.jpg' } });
  const again = await Payout.findOne({ reference: 'PO-R1' });
  const two = await markPayoutPaid(again, { proof: { url: '/p.jpg' } });

  const after = await Payout.findOne({ reference: 'PO-R1' });
  assert.equal(one.alreadyPaid, undefined);
  assert.equal(two.alreadyPaid, true, 'the second click is recognised as a repeat');
  assert.equal(after.amount, 700000);
});

test('a second advance is not raided by re-marking an already-paid payout', async () => {
  const { releaseDuePayouts, markPayoutPaid } = await import('../src/services/payments.js');
  const { Payout } = await import('../src/models/index.js');
  const n = await nanny();

  await advance(n, 300000, 'ADV-R2');
  await earnings(n, 1000000, 'PO-R2');
  await releaseDuePayouts(MONDAY);
  await markPayoutPaid(await Payout.findOne({ reference: 'PO-R2' }), { proof: { url: '/p.jpg' } });

  await advance(n, 200000, 'ADV-R3');
  await markPayoutPaid(await Payout.findOne({ reference: 'PO-R2' }), { proof: { url: '/p.jpg' } });

  const settled = await Payout.findOne({ reference: 'PO-R2' });
  const fresh = await Payout.findOne({ reference: 'ADV-R3' });
  assert.equal(settled.amount, 700000, 'her already-paid wages must not shrink again');
  assert.equal(settled.advanceRecovered, 300000, 'and the audit trail must survive');
  assert.equal(fresh.advance.outstanding, 200000, 'the new advance is untouched');
});

test('two releases at once cannot both recover the same advance', async () => {
  const { releaseDuePayouts } = await import('../src/services/payments.js');
  const { Payout } = await import('../src/models/index.js');
  const n = await nanny();

  await advance(n, 300000, 'ADV-R4');
  await earnings(n, 1000000, 'PO-R3');
  await earnings(n, 1000000, 'PO-R4');

  await Promise.all([releaseDuePayouts(MONDAY), releaseDuePayouts(MONDAY)]);

  const rows = await Payout.find({ reference: { $in: ['PO-R3', 'PO-R4'] } });
  const totalSent = rows.reduce((s, r) => s + r.amount, 0);
  assert.equal(totalSent, 1700000, 'only one 300k advance comes off the two payouts');
});

test('an advance is not taken before the month it is due from', async () => {
  const { releaseDuePayouts } = await import('../src/services/payments.js');
  const { Payout } = await import('../src/models/index.js');
  const n = await nanny();

  await Payout.create({
    reference: 'ADV-R5', nanny: n._id, kind: 'advance', amount: 300000, status: 'completed',
    advance: { outstanding: 300000, recoverFrom: '2026-10' },
  });
  await earnings(n, 1000000, 'PO-R5');
  await releaseDuePayouts(MONDAY);

  const wages = await Payout.findOne({ reference: 'PO-R5' });
  assert.equal(wages.amount, 1000000, 'October\'s advance does not come off September\'s pay');
});

test('a payout already marked paid is never flipped back by the Monday release', async () => {
  const { releaseDuePayouts, markPayoutPaid } = await import('../src/services/payments.js');
  const { Payout } = await import('../src/models/index.js');
  const n = await nanny();

  const wages = await earnings(n, 1000000, 'PO-R6');
  await markPayoutPaid(wages, { proof: { url: '/p.jpg' } });
  await releaseDuePayouts(MONDAY);

  const after = await Payout.findOne({ reference: 'PO-R6' });
  assert.equal(after.status, 'completed');
});
