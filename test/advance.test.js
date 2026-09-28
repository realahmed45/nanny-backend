import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, clearDb } from './helpers.js';

/**
 * An advance is her own salary, early. It has to come back off the next
 * payout — and when it is larger than that payout, the rest has to wait
 * rather than being clawed back from somebody who has already spent it.
 */

before(setupDb);
after(teardownDb);
beforeEach(clearDb);

async function nanny() {
  const { User } = await import('../src/models/index.js');
  return User.create({
    role: 'nanny', phone: '999900000001', fullName: 'Sari', hourlyRate: 50000,
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

test('an advance comes off the next payout', async () => {
  const { markPayoutPaid } = await import('../src/services/payments.js');
  const { Payout } = await import('../src/models/index.js');
  const n = await nanny();

  await advance(n, 300000, 'ADV-1');
  const wages = await earnings(n, 1000000, 'PO-1');

  const { payout, advance: rec } = await markPayoutPaid(wages, { proof: { url: '/p.jpg' } });

  assert.equal(rec.recovered, 300000);
  assert.equal(payout.amount, 700000, 'she is sent what is left');
  assert.equal(payout.advanceRecovered, 300000, 'and the reason is recorded');

  const cleared = await Payout.findOne({ reference: 'ADV-1' });
  assert.equal(cleared.advance.outstanding, 0);
  assert.ok(cleared.advance.recoveredAt, 'settled advances are stamped');
});

test('an advance bigger than the payout carries forward', async () => {
  const { markPayoutPaid } = await import('../src/services/payments.js');
  const { Payout } = await import('../src/models/index.js');
  const n = await nanny();

  await advance(n, 2000000, 'ADV-2');
  const wages = await earnings(n, 1400000, 'PO-2');

  const { payout } = await markPayoutPaid(wages, { proof: { url: '/p.jpg' } });

  assert.equal(payout.amount, 0, 'the payout goes to zero, never negative');

  const still = await Payout.findOne({ reference: 'ADV-2' });
  assert.equal(still.advance.outstanding, 600000, 'the rest waits for next time');
  assert.equal(still.advance.recoveredAt, undefined, 'and is not marked settled');
});

test('advances clear oldest first', async () => {
  const { markPayoutPaid } = await import('../src/services/payments.js');
  const { Payout } = await import('../src/models/index.js');
  const n = await nanny();

  const first = await advance(n, 200000, 'ADV-3');
  // Ensure a distinct createdAt, since the order is what is being asserted.
  await new Promise((r) => { setTimeout(r, 12); });
  await advance(n, 500000, 'ADV-4');

  const wages = await earnings(n, 300000, 'PO-3');
  await markPayoutPaid(wages, { proof: { url: '/p.jpg' } });

  const older = await Payout.findById(first._id);
  const newer = await Payout.findOne({ reference: 'ADV-4' });

  assert.equal(older.advance.outstanding, 0, 'the oldest debt clears first');
  assert.equal(newer.advance.outstanding, 400000, 'the newer one takes what is left');
});

test('an advance never pays for itself', async () => {
  const { markPayoutPaid } = await import('../src/services/payments.js');
  const n = await nanny();

  const adv = await advance(n, 500000, 'ADV-5');
  const { payout, advance: rec } = await markPayoutPaid(adv, { proof: { url: '/p.jpg' } });

  assert.equal(rec.recovered, 0);
  assert.equal(payout.amount, 500000, 'the advance is paid in full, not netted off itself');
});

test('a nanny with no advances is paid in full', async () => {
  const { markPayoutPaid } = await import('../src/services/payments.js');
  const n = await nanny();

  const wages = await earnings(n, 850000, 'PO-4');
  const { payout, advance: rec } = await markPayoutPaid(wages, { proof: { url: '/p.jpg' } });

  assert.equal(rec.recovered, 0);
  assert.equal(payout.amount, 850000);
});

/**
 * Why she needed money early is hers, and there is no reason for it to sit in
 * the database once the month it came off has closed.
 */

/** An advance dated into a past month, which is what redaction looks for. */
const datedAdvance = async (n, ref, createdAt) => {
  const { Payout } = await import('../src/models/index.js');
  const p = await Payout.create({
    reference: ref, nanny: n._id, kind: 'advance', amount: 400000,
    status: 'completed',
    reason: 'Medical bill for her son',
    notes: 'Handed over in cash at the office',
    proof: { url: '/proof.jpg', uploadedAt: createdAt },
    advance: { outstanding: 400000, recoverFrom: '2026-08' },
  });
  // createdAt is set by timestamps, so it is forced past the setter.
  await p.constructor.collection.updateOne({ _id: p._id }, { $set: { createdAt } });
  return p;
};

test('an advance from a closed month has its reason and photo cleared', async () => {
  const { redactExpiredAdvances } = await import('../src/services/finance.js');
  const { Payout } = await import('../src/models/index.js');
  const n = await nanny();

  await datedAdvance(n, 'ADV-6', new Date('2026-08-14T10:00:00Z'));

  const count = await redactExpiredAdvances(new Date('2026-09-23T02:00:00Z'));
  assert.equal(count, 1);

  const done = await Payout.findOne({ reference: 'ADV-6' });
  assert.equal(done.reason, undefined, 'the reason is gone');
  assert.equal(done.notes, undefined, 'and so is the note');
  assert.equal(done.proof?.url, undefined, 'and the photo with them');
  assert.ok(done.redactedAt, 'and it is stamped as redacted');

  assert.equal(done.amount, 400000, 'but the amount stays');
  assert.equal(done.advance.outstanding, 400000, 'and so does what is still owed');
});

test('an advance from the current month is left alone', async () => {
  const { redactExpiredAdvances } = await import('../src/services/finance.js');
  const { Payout } = await import('../src/models/index.js');
  const n = await nanny();

  await datedAdvance(n, 'ADV-7', new Date('2026-09-03T10:00:00Z'));

  const count = await redactExpiredAdvances(new Date('2026-09-23T02:00:00Z'));
  assert.equal(count, 0);

  const untouched = await Payout.findOne({ reference: 'ADV-7' });
  assert.equal(untouched.reason, 'Medical bill for her son');
  assert.equal(untouched.proof.url, '/proof.jpg');
  assert.equal(untouched.redactedAt, undefined);
});

test('redaction does not run twice over the same advance', async () => {
  const { redactExpiredAdvances } = await import('../src/services/finance.js');
  const n = await nanny();

  await datedAdvance(n, 'ADV-8', new Date('2026-08-14T10:00:00Z'));

  const now = new Date('2026-09-23T02:00:00Z');
  assert.equal(await redactExpiredAdvances(now), 1);
  assert.equal(await redactExpiredAdvances(now), 0, 'the second pass finds nothing');
});

test('only advances are redacted — a special payout keeps its receipt', async () => {
  const { redactExpiredAdvances } = await import('../src/services/finance.js');
  const { Payout } = await import('../src/models/index.js');
  const n = await nanny();

  const special = await Payout.create({
    reference: 'PO-9', nanny: n._id, kind: 'special', amount: 90000,
    status: 'completed',
    reason: 'Taxi to the Seminyak booking',
    costProof: { url: '/receipt.jpg' },
  });
  await special.constructor.collection.updateOne(
    { _id: special._id },
    { $set: { createdAt: new Date('2026-08-14T10:00:00Z') } },
  );

  await redactExpiredAdvances(new Date('2026-09-23T02:00:00Z'));

  const kept = await Payout.findOne({ reference: 'PO-9' });
  assert.equal(kept.reason, 'Taxi to the Seminyak booking', 'an expense still needs its reason');
  assert.equal(kept.costProof.url, '/receipt.jpg');
});
