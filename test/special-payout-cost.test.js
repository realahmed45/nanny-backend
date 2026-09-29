import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { setupDb, teardownDb, clearDb } from './helpers.js';
import { Cost } from '../src/models/index.js';
import { Payout } from '../src/models/Payment.js';

/**
 * A special payout must reduce reported profit.
 *
 * Net profit is commission minus the cost ledger. A special payout —
 * reimbursing a nanny for a taxi or a uniform — appeared in neither, so the
 * money left the business and the profit figure never moved. Profit was
 * overstated by the total of every special payout ever made.
 */

before(setupDb);
after(teardownDb);
beforeEach(clearDb);

test('a cost recording a special payout counts toward the cost total', async () => {
  const payout = await Payout.create({
    reference: 'PO-000001',
    nanny: new mongoose.Types.ObjectId(),
    kind: 'special',
    amount: 250000,
    reason: 'Taxi to an emergency booking',
    scheduledFor: new Date(),
  });

  await Cost.create({
    spentOn: new Date(),
    category: 'other',
    description: `Special payout ${payout.reference} — ${payout.reason}`,
    amount: payout.amount,
    payout: payout._id,
  });

  const [{ total } = { total: 0 }] = await Cost.aggregate([
    { $match: { voided: { $ne: true } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);

  assert.equal(total, 250000, 'the payout shows up in the cost total');
});

test('the same payout cannot be recorded as a cost twice', async () => {
  // Without this, an approval retried after a slow response would subtract the
  // same money from profit twice — the opposite error, equally wrong.
  const payoutId = new mongoose.Types.ObjectId();

  await Cost.create({
    spentOn: new Date(),
    category: 'other',
    description: 'Special payout PO-000002',
    amount: 100000,
    payout: payoutId,
  });

  await assert.rejects(
    () => Cost.create({
      spentOn: new Date(),
      category: 'other',
      description: 'Special payout PO-000002 again',
      amount: 100000,
      payout: payoutId,
    }),
    /duplicate key|E11000/i,
    'the unique link on payout refuses the second row',
  );

  const count = await Cost.countDocuments({ payout: payoutId });
  assert.equal(count, 1);
});

test('ordinary costs are unaffected by the new link', async () => {
  // The link is sparse, so any number of costs may have no payout at all.
  await Cost.create({
    spentOn: new Date(), category: 'rent', description: 'Office rent', amount: 5e6,
  });
  await Cost.create({
    spentOn: new Date(), category: 'transport', description: 'Petrol', amount: 2e5,
  });

  const count = await Cost.countDocuments({});
  assert.equal(count, 2, 'two costs with no payout link coexist');
});
