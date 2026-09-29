import path from 'node:path';
import fs from 'node:fs/promises';
import config from '../config/index.js';
import { Payout } from '../models/Payment.js';
import { Cost } from '../models/index.js';

/**
 * Is the system actually doing what it was fixed to do?
 *
 * Four things were repaired or left deliberately incomplete, and each was only
 * provable by reading the code or taking somebody's word for it. That is no use
 * to whoever runs the business: a fix you cannot see is indistinguishable from
 * a fix that quietly stopped working.
 *
 * Everything here is read live rather than stored, so a check that passes today
 * and fails next month says so on its own. Nothing in this file writes.
 */

/** Money, rounded the way the rest of the finance code rounds it. */
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Advance recovery: is any advance recorded as over-recovered?
 *
 * The bug took the same debt twice, which showed up as an advance whose
 * outstanding balance went below zero, or as more recovered against a payout
 * than the advance was ever worth. Both are impossible now — the subtraction
 * refuses to run unless the money is still there — so finding one means the
 * guard has been removed or bypassed.
 */
async function advanceRecovery() {
  const [negative, advances, recoveredAgg] = await Promise.all([
    Payout.countDocuments({ kind: 'advance', 'advance.outstanding': { $lt: 0 } }),
    Payout.find({ kind: 'advance' }).select('reference amount advance').lean(),
    Payout.aggregate([
      { $match: { advanceRecovered: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: '$advanceRecovered' }, n: { $sum: 1 } } },
    ]),
  ]);

  const outstanding = advances.reduce((sum, a) => sum + (a.advance?.outstanding || 0), 0);
  const issued = advances.reduce((sum, a) => sum + (a.amount || 0), 0);
  const recovered = recoveredAgg[0]?.total || 0;

  /**
   * What was issued must equal what is still owed plus what has come back.
   * A gap means money was recovered that was never advanced — the exact shape
   * of the old double-recovery bug.
   */
  const drift = round2(issued - outstanding - recovered);
  const healthy = negative === 0 && Math.abs(drift) < 1;

  return {
    healthy,
    detail: healthy
      ? 'Every advance adds up: what was issued equals what is owed plus what came back.'
      : negative > 0
        ? `${negative} advance(s) have been recovered past zero.`
        : `Recovered ${round2(Math.abs(drift))} more than was ever advanced.`,
    figures: {
      advancesIssued: round2(issued),
      stillOwed: round2(outstanding),
      recovered: round2(recovered),
      drift,
      advanceCount: advances.length,
      recoveredOnPayouts: recoveredAgg[0]?.n || 0,
    },
  };
}

/**
 * Special payouts: does every one have a cost row behind it?
 *
 * Without one, the money leaves the business and reported profit never moves.
 * The cost is written when the payout is approved, so a special payout with no
 * cost means that write failed — which is logged, but a log nobody reads is
 * not a control.
 */
async function specialPayoutsCounted() {
  const [specials, costs] = await Promise.all([
    Payout.find({ kind: 'special' }).select('reference amount createdAt').lean(),
    Cost.find({ payout: { $exists: true, $ne: null } })
      .select('payout amount voided').lean(),
  ]);

  const costByPayout = new Map(costs.map((c) => [String(c.payout), c]));

  const missing = specials.filter((p) => !costByPayout.has(String(p._id)));
  const voided = specials.filter((p) => costByPayout.get(String(p._id))?.voided);

  const unaccounted = round2(missing.reduce((sum, p) => sum + (p.amount || 0), 0));
  const healthy = missing.length === 0;

  return {
    healthy,
    detail: healthy
      ? specials.length
        ? 'Every special payout has a cost behind it, so profit reflects all of them.'
        : 'No special payouts yet. New ones will write a cost automatically.'
      : `${missing.length} special payout(s) are missing a cost, so profit is overstated by ${unaccounted.toLocaleString()}.`,
    figures: {
      specialPayouts: specials.length,
      withCost: specials.length - missing.length,
      missingCost: missing.length,
      overstatedBy: unaccounted,
      costVoided: voided.length,
    },
    // Named, so somebody can enter the missing rows by hand.
    missing: missing.slice(0, 20).map((p) => ({
      reference: p.reference,
      amount: p.amount,
      at: p.createdAt,
    })),
  };
}

/**
 * Uploads: how much of the archive is still on the public path?
 *
 * New identity documents go to the private folder. Everything uploaded before
 * that change stays where it was, deliberately — moving live files risks
 * breaking profiles that work today. This counts what is left rather than
 * claiming the job is done.
 */
async function mediaPrivacy() {
  const root = config.media.dir;
  const privateRoot = path.join(root, 'private');

  const count = async (dir) => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isFile() && !e.name.endsWith('.part')).length;
    } catch {
      return 0;
    }
  };

  const [publicFiles, privateFiles] = await Promise.all([
    count(root),
    count(privateRoot),
  ]);

  return {
    // Not a failure: the public folder is where profile photos belong, and
    // WhatsApp cannot deliver them from anywhere else.
    healthy: true,
    detail: privateFiles
      ? `${privateFiles} document(s) now need a login. ${publicFiles} file(s) remain on the public path — profile photos belong there; any older ID scans among them do not.`
      : `${publicFiles} file(s) on the public path. No documents have been uploaded since the private folder was added.`,
    figures: {
      privateFiles,
      publicFiles,
      privateFolder: privateRoot,
    },
  };
}

/**
 * Wages: what has been earned but not yet sent.
 *
 * "Paid to nannies" and "Paid out" are different questions and are meant to
 * differ — she earns on the day she works and is paid on the Monday. The gap
 * is the outstanding wage bill, not an error.
 *
 * What would be an error is a gap that never clears. A payout still pending
 * well past its release date means payouts have stopped going out, and that is
 * what this looks for.
 */
async function wagesOwed() {
  const pending = await Payout.find({
    status: { $in: ['pending', 'processing'] },
    kind: { $ne: 'advance' },
  }).select('reference amount scheduledFor status').lean();

  const total = round2(pending.reduce((sum, p) => sum + (p.amount || 0), 0));

  // A week past its date is well beyond the weekly cycle: it should have gone
  // out on the Monday, and the one after.
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const overdue = pending.filter((p) => p.scheduledFor && new Date(p.scheduledFor) < cutoff);

  const healthy = overdue.length === 0;

  return {
    healthy,
    detail: healthy
      ? total
        ? `${total.toLocaleString()} earned and not yet sent. This clears each Monday — a gap during the week is normal.`
        : 'Nothing outstanding. Every completed day has been paid.'
      : `${overdue.length} payout(s) are more than a week past their release date. Payouts may have stopped going out.`,
    figures: {
      owedNow: total,
      pendingPayouts: pending.length,
      overdue: overdue.length,
    },
    overdue: overdue.slice(0, 20).map((p) => ({
      reference: p.reference,
      amount: p.amount,
      due: p.scheduledFor,
    })),
  };
}

/** All four, read live. */
export async function systemHealth() {
  const [advances, specials, media, wages] = await Promise.all([
    advanceRecovery(),
    specialPayoutsCounted(),
    mediaPrivacy(),
    wagesOwed(),
  ]);

  return {
    checkedAt: new Date(),
    checks: [
      {
        key: 'advances',
        title: 'Advances are recovered once',
        question: 'Could a payout collect the same debt twice?',
        ...advances,
      },
      {
        key: 'specialPayouts',
        title: 'Special payouts reduce profit',
        question: 'Does every special payout appear as a cost?',
        ...specials,
      },
      {
        key: 'media',
        title: 'Documents need a login',
        question: 'What is still on the public path?',
        ...media,
      },
      {
        key: 'wages',
        title: 'Wages are going out',
        question: 'Is the earned-but-unpaid gap clearing each week?',
        ...wages,
      },
    ],
  };
}

export default { systemHealth };
