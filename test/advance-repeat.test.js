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
  return Payout.create({ reference: ref, nanny: n._id, amount, status: 'pending' });
};

test('marking the same payout paid twice does not recover twice', async () => {
  const { markPayoutPaid } = await import('../src/services/payments.js');
  const { Payout } = await import('../src/models/index.js');
  const n = await nanny();

  await advance(n, 300000, 'ADV-R1');
  const wages = await earnings(n, 1000000, 'PO-R1');

  await markPayoutPaid(wages, { proof: { url: '/p.jpg' } });
  const afterFirst = (await Payout.findOne({ reference: 'PO-R1' })).amount;

  // The retry: same row, marked paid again.
  const again = await Payout.findOne({ reference: 'PO-R1' });
  await markPayoutPaid(again, { proof: { url: '/p.jpg' } });

  const afterSecond = await Payout.findOne({ reference: 'PO-R1' });
  assert.equal(afterFirst, 700000, 'the first pass recovers the advance');
  assert.equal(afterSecond.amount, 700000, 'the second pass must not move the amount again');
});

test('a second advance is not raided by re-marking an already-paid payout', async () => {
  const { markPayoutPaid } = await import('../src/services/payments.js');
  const { Payout } = await import('../src/models/index.js');
  const n = await nanny();

  await advance(n, 300000, 'ADV-R2');
  const wages = await earnings(n, 1000000, 'PO-R2');
  await markPayoutPaid(wages, { proof: { url: '/p.jpg' } });

  // She is given a fresh advance after the payout was settled.
  await advance(n, 200000, 'ADV-R3');

  const again = await Payout.findOne({ reference: 'PO-R2' });
  await markPayoutPaid(again, { proof: { url: '/p.jpg' } });

  const settled = await Payout.findOne({ reference: 'PO-R2' });
  const fresh = await Payout.findOne({ reference: 'ADV-R3' });

  assert.equal(settled.amount, 700000, 'her already-paid wages must not shrink again');
  assert.equal(settled.advanceRecovered, 300000, 'and the audit trail must survive');
  assert.equal(fresh.advance.outstanding, 200000, 'the new advance is untouched');
});

test('two payouts settled at once cannot both recover the same advance', async () => {
  const { markPayoutPaid } = await import('../src/services/payments.js');
  const { Payout } = await import('../src/models/index.js');
  const n = await nanny();

  await advance(n, 300000, 'ADV-R4');
  const a = await earnings(n, 1000000, 'PO-R3');
  const b = await earnings(n, 1000000, 'PO-R4');

  await Promise.all([
    markPayoutPaid(a, { proof: { url: '/p.jpg' } }),
    markPayoutPaid(b, { proof: { url: '/p.jpg' } }),
  ]);

  const rows = await Payout.find({ reference: { $in: ['PO-R3', 'PO-R4'] } });
  const totalSent = rows.reduce((s, r) => s + r.amount, 0);

  assert.equal(totalSent, 1700000, 'only one 300k advance comes off the two payouts');
});
