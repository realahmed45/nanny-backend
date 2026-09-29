import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { setupDb, teardownDb, clearDb } from './helpers.js';
import { systemHealth } from '../src/services/health.js';
import { Payout } from '../src/models/Payment.js';
import { Cost } from '../src/models/index.js';

/**
 * The health page has to be able to report a failure.
 *
 * A check that says "all clear" whatever the data is worse than no check: it
 * tells whoever runs the business that a safeguard is holding when it is not.
 * So each of these breaks the data deliberately and asserts the page notices.
 */

before(setupDb);
after(teardownDb);
beforeEach(clearDb);

const find = (report, key) => report.checks.find((c) => c.key === key);

test('a clean system reports every check healthy', async () => {
  const report = await systemHealth();
  for (const check of report.checks) {
    assert.equal(check.healthy, true, `${check.key} should be healthy when there is no data`);
  }
});

test('an advance recovered past zero is reported', async () => {
  await Payout.create({
    reference: 'PO-100001',
    nanny: new mongoose.Types.ObjectId(),
    kind: 'advance',
    amount: 300000,
    // The shape the old double-recovery bug produced.
    advance: { outstanding: -300000 },
    scheduledFor: new Date(),
  });

  const check = find(await systemHealth(), 'advances');
  assert.equal(check.healthy, false);
  assert.match(check.detail, /past zero/i);
});

test('recovering more than was ever advanced is reported', async () => {
  const nanny = new mongoose.Types.ObjectId();
  await Payout.create({
    reference: 'PO-100002',
    nanny,
    kind: 'advance',
    amount: 300000,
    advance: { outstanding: 0 },
    scheduledFor: new Date(),
  });
  // Two payouts each claiming to have recovered the whole advance.
  await Payout.create({
    reference: 'PO-100003', nanny, kind: 'earnings', amount: 700000,
    advanceRecovered: 300000, scheduledFor: new Date(),
  });
  await Payout.create({
    reference: 'PO-100004', nanny, kind: 'earnings', amount: 700000,
    advanceRecovered: 300000, scheduledFor: new Date(),
  });

  const check = find(await systemHealth(), 'advances');
  assert.equal(check.healthy, false, 'double recovery must be visible');
  assert.equal(check.figures.recovered, 600000);
});

test('a special payout with no cost behind it is named', async () => {
  await Payout.create({
    reference: 'PO-200001',
    nanny: new mongoose.Types.ObjectId(),
    kind: 'special',
    amount: 250000,
    reason: 'Taxi',
    scheduledFor: new Date(),
  });

  const check = find(await systemHealth(), 'specialPayouts');
  assert.equal(check.healthy, false);
  assert.equal(check.figures.missingCost, 1);
  assert.equal(check.figures.overstatedBy, 250000);
  assert.equal(check.missing[0].reference, 'PO-200001', 'it names the payout');
});

test('a special payout with a cost behind it passes', async () => {
  const payout = await Payout.create({
    reference: 'PO-200002',
    nanny: new mongoose.Types.ObjectId(),
    kind: 'special',
    amount: 250000,
    reason: 'Uniform',
    scheduledFor: new Date(),
  });
  await Cost.create({
    spentOn: new Date(),
    category: 'other',
    description: 'Special payout PO-200002',
    amount: 250000,
    payout: payout._id,
  });

  const check = find(await systemHealth(), 'specialPayouts');
  assert.equal(check.healthy, true);
  assert.equal(check.figures.withCost, 1);
  assert.equal(check.figures.overstatedBy, 0);
});

test('a payout long past its release date is flagged', async () => {
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await Payout.create({
    reference: 'PO-300001',
    nanny: new mongoose.Types.ObjectId(),
    kind: 'earnings',
    amount: 500000,
    status: 'pending',
    scheduledFor: longAgo,
  });

  const check = find(await systemHealth(), 'wages');
  assert.equal(check.healthy, false, 'payouts that stopped going out must show');
  assert.equal(check.figures.overdue, 1);
});

test('a payout due this week is normal, not a failure', async () => {
  // Earned Tuesday, released Monday: the gap is the point, not a fault.
  await Payout.create({
    reference: 'PO-300002',
    nanny: new mongoose.Types.ObjectId(),
    kind: 'earnings',
    amount: 500000,
    status: 'pending',
    scheduledFor: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
  });

  const check = find(await systemHealth(), 'wages');
  assert.equal(check.healthy, true);
  assert.equal(check.figures.owedNow, 500000);
});
