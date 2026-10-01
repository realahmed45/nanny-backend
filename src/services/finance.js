import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { Cost, Payout } from '../models/index.js';
import { PAYOUT_STATUS } from '../utils/constants.js';
import { earningsSummary } from './earnings.js';
import config from '../config/index.js';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * The reporting window, in the timezone the business actually runs in.
 *
 * These used a bare `dayjs()`, which reads the server's zone. The server runs
 * UTC and the business runs UTC+8, so "this month" began eight hours late:
 * anything completed between midnight and 8am Bali time on the 1st was counted
 * in the previous month. Same at the end of a chosen range, and the same for a
 * day picked in the dashboard — "1 October" meant 08:00 on the 1st.
 *
 * Small most days and wrong exactly when it matters: at a month end, when the
 * figures are being closed off and compared against the bank.
 */
const TZ = () => config.timezone;

/** Start of the given day (or of the current month) in business time. */
function windowStart(from) {
  return from
    ? dayjs.tz(from, TZ()).startOf('day').toDate()
    : dayjs().tz(TZ()).startOf('month').toDate();
}

/** End of the given day (or of today) in business time. */
function windowEnd(to) {
  return to
    ? dayjs.tz(to, TZ()).endOf('day').toDate()
    : dayjs().tz(TZ()).endOf('day').toDate();
}

/**
 * What the business actually made, once everything is set against it.
 *
 * `earningsSummary` answers "what did we keep on the bookings?" — charged,
 * less what the nannies were paid. That is gross margin, and it is the number
 * a dashboard reports when nobody has told it about the rent.
 *
 * This adds the rest: the costs somebody typed into the Cost tab, which pass
 * through no booking and appear nowhere else in the system. Commission minus
 * those is the only figure here that corresponds to money in the bank.
 *
 * Three views of the same period, because they answer different questions:
 *
 *   by client — which families are worth having. A family who books often at
 *               a thin margin can be worth less than one who books rarely at
 *               a wide one, and only this view shows it.
 *   by nanny  — which placements earn their keep. Her rate against what the
 *               family paid, per nanny, so a rate that no longer works is
 *               visible before the year's accounts say so.
 *   payouts   — what actually left the building, which is not the same as
 *               what the bookings say she was owed.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Statuses that mean the money is gone, as opposed to still owed. */
const SETTLED = new Set([PAYOUT_STATUS.COMPLETED, PAYOUT_STATUS.FINAL_DONE]);

/**
 * Costs in a period, with their totals.
 *
 * Voided rows are excluded from every total but still counted, so a figure
 * that looks wrong can be traced to somebody having voided something rather
 * than to the arithmetic.
 */
export async function costSummary({ from, to } = {}) {
  const start = windowStart(from);
  const end = windowEnd(to);

  const all = await Cost.find({ spentOn: { $gte: start, $lte: end } })
    .populate('createdBy', 'name email')
    .sort({ spentOn: -1 })
    .lean();

  const live = all.filter((c) => !c.voided);

  const byCategory = {};
  let total = 0;
  for (const c of live) {
    const amount = round2(c.amount);
    total += amount;
    byCategory[c.category] = round2((byCategory[c.category] || 0) + amount);
  }

  return {
    rows: all,
    total: round2(total),
    byCategory,
    voidedCount: all.length - live.length,
  };
}

/**
 * What was actually paid out to nannies in the period.
 *
 * Deliberately separate from `paidToNannies` in the earnings summary: that
 * is what the bookings say she earned, this is what left the account. They
 * diverge whenever a payout is queued but not yet released, which is most
 * of any given week, and treating them as the same number is how a cash
 * figure ends up describing an obligation.
 */
export async function payoutSummary({ from, to } = {}) {
  const start = windowStart(from);
  const end = windowEnd(to);

  /**
   * Dated by when the money moved, not when the row was made.
   *
   * A payout queued on 28 August and released on 3 September is September's
   * cash and August's obligation. Ranging everything on `createdAt` put the
   * released amount in August — a "paid" figure describing neither the cash
   * that left nor the debt that stood.
   *
   * So a settled payout is matched on `releasedAt` and an unsettled one on
   * `createdAt`, which is the only date it has.
   */
  const payouts = await Payout.find({
    $or: [
      { releasedAt: { $gte: start, $lte: end } },
      { releasedAt: { $in: [null, undefined] }, createdAt: { $gte: start, $lte: end } },
    ],
  })
    .populate('nanny', 'fullName nickname phone profilePhotoUrl')
    .sort({ createdAt: -1 })
    .lean();

  const byStatus = {};
  const byNanny = new Map();
  let paid = 0;
  let pending = 0;

  for (const p of payouts) {
    const amount = round2(p.amount);
    byStatus[p.status] = round2((byStatus[p.status] || 0) + amount);

    /**
     * Settled means the money has left. Anything still moving is an
     * obligation, and a failed payout is neither — it is money still owed
     * that nobody has yet been able to send, so it belongs in pending
     * rather than being quietly dropped from both figures.
     */
    if (SETTLED.has(p.status)) paid += amount;
    else pending += amount;

    const id = String(p.nanny?._id || p.nanny || 'unknown');
    const row = byNanny.get(id) || {
      nannyId: id,
      name: p.nanny?.fullName || p.nanny?.nickname || 'Unknown',
      profilePhotoUrl: p.nanny?.profilePhotoUrl || null,
      paid: 0,
      pending: 0,
      count: 0,
    };
    if (SETTLED.has(p.status)) row.paid = round2(row.paid + amount);
    else row.pending = round2(row.pending + amount);
    row.count += 1;
    byNanny.set(id, row);
  }

  return {
    rows: payouts,
    paid: round2(paid),
    pending: round2(pending),
    byStatus,
    byNanny: [...byNanny.values()].sort((a, b) => (b.paid + b.pending) - (a.paid + a.pending)),
  };
}


/**
 * What is due to go out over the next stretch of days.
 *
 * Payouts are scheduled the moment work completes, so the obligation exists
 * well before the money moves. Knowing the total is not the same as knowing
 * when: a month that balances overall can still have a Monday that does not,
 * and the point of a forecast is to see that Monday coming.
 *
 * Advances are subtracted from the day they are meant to be recovered on,
 * because a nanny who has already been paid early is not owed it twice.
 */
export async function salaryForecast({ days = 10, from = new Date() } = {}) {
  // Business time, so "the next 10 days" starts at midnight in Bali rather
  // than at 8am, which would drop the first morning's payouts.
  const start = dayjs(from).tz(TZ()).startOf('day');
  const end = start.add(days - 1, 'day').endOf('day');

  const due = await Payout.find({
    status: { $in: [PAYOUT_STATUS.PENDING, PAYOUT_STATUS.PROCESSING] },
    scheduledFor: { $gte: start.toDate(), $lte: end.toDate() },
  })
    .populate('nanny', 'fullName nickname')
    .sort({ scheduledFor: 1 })
    .lean();

  // One row per day, including the quiet ones — a gap in a forecast reads as
  // missing data, where a zero reads as nothing due.
  const byDay = new Map();
  for (let i = 0; i < days; i += 1) {
    const d = start.add(i, 'day');
    byDay.set(d.format('YYYY-MM-DD'), {
      date: d.format('YYYY-MM-DD'),
      weekday: d.format('ddd'),
      amount: 0,
      advances: 0,
      count: 0,
      nannies: [],
    });
  }

  let total = 0;
  let advanceTotal = 0;

  /**
   * Advances still to be recovered, by nanny.
   *
   * Advances are recorded as already paid, so they were never among the
   * pending payouts this loop reads, and the subtraction below never ran: the
   * forecast always showed the full wages as cash needed. They are loaded on
   * their own and taken off each nanny's next payouts, from the month they
   * are due — the same rule the release applies.
   */
  const openAdvances = await Payout.find({
    kind: 'advance',
    'advance.outstanding': { $gt: 0 },
  }).sort({ createdAt: 1 }).lean();
  const owedBy = new Map();
  for (const a of openAdvances) {
    const key = String(a.nanny);
    owedBy.set(key, [...(owedBy.get(key) || []), {
      left: round2(a.advance.outstanding), from: a.advance.recoverFrom || '',
    }]);
  }

  for (const p of due) {
    const when = dayjs(p.scheduledFor).tz(TZ());
    const key = when.format('YYYY-MM-DD');
    const row = byDay.get(key);
    if (!row) continue;

    const amount = round2(p.amount);
    const name = p.nanny?.fullName || p.nanny?.nickname || 'Unknown';

    if (p.kind === 'advance') continue;

    row.amount = round2(row.amount + amount);
    total += amount;
    row.count += 1;
    if (!row.nannies.includes(name)) row.nannies.push(name);

    // Already recovered when it was released: nothing more comes off it.
    if (p.status === PAYOUT_STATUS.PENDING) {
      let available = amount;
      for (const adv of owedBy.get(String(p.nanny?._id || p.nanny)) || []) {
        if (available <= 0) break;
        if (adv.left <= 0 || (adv.from && adv.from > when.format('YYYY-MM'))) continue;
        const take = Math.min(adv.left, available);
        adv.left = round2(adv.left - take);
        available = round2(available - take);
        row.advances = round2(row.advances + take);
        advanceTotal += take;
      }
    }
    byDay.set(key, row);
  }

  const rows = [...byDay.values()].map((r) => ({
    ...r,
    net: round2(r.amount - r.advances),
  }));

  return {
    from: start.format('YYYY-MM-DD'),
    to: end.format('YYYY-MM-DD'),
    days,
    rows,
    total: round2(total),
    advances: round2(advanceTotal),
    net: round2(total - advanceTotal),
    // The single heaviest day, which is the one worth having cash ready for.
    peak: rows.reduce((max, r) => (r.net > (max?.net ?? -1) ? r : max), null),
  };
}

/**
 * Advances still to be recovered, per nanny.
 *
 * An advance is her own salary paid early, so it is tracked until it is taken
 * back off a payout rather than simply recorded. What is outstanding is what
 * the business is owed from wages not yet run.
 */
export async function outstandingAdvances() {
  const open = await Payout.find({
    kind: 'advance',
    'advance.outstanding': { $gt: 0 },
  })
    .populate('nanny', 'fullName nickname profilePhotoUrl')
    .sort({ createdAt: 1 })
    .lean();

  const byNanny = new Map();
  let total = 0;

  for (const a of open) {
    const id = String(a.nanny?._id || a.nanny || 'unknown');
    const amount = round2(a.advance?.outstanding || 0);
    total += amount;

    const row = byNanny.get(id) || {
      nannyId: id,
      name: a.nanny?.fullName || a.nanny?.nickname || 'Unknown',
      profilePhotoUrl: a.nanny?.profilePhotoUrl || null,
      outstanding: 0,
      items: [],
    };
    row.outstanding = round2(row.outstanding + amount);
    row.items.push({
      id: String(a._id),
      reference: a.reference,
      amount: round2(a.amount),
      outstanding: amount,
      reason: a.reason,
      recoverFrom: a.advance?.recoverFrom,
      paidAt: a.createdAt,
      proofUrl: a.proof?.url || null,
      redactedAt: a.redactedAt || null,
    });
    byNanny.set(id, row);
  }

  return {
    total: round2(total),
    byNanny: [...byNanny.values()].sort((a, b) => b.outstanding - a.outstanding),
  };
}

/**
 * Clear the reason, note and proof photo off advances from months that have
 * closed.
 *
 * Why she needed money early — a family emergency, a medical bill — is hers,
 * not a record the business needs to keep once the salary it came off has
 * been run. The advance itself (amount, date, who) stays: only the personal
 * detail is wiped, once, the first time this runs after her month ends.
 */
export async function redactExpiredAdvances(now = new Date()) {
  // Bali's month, not the server's. On a UTC server the month "began" at 8am
  // Bali time, so an advance made on the 1st before then was wiped the next
  // night — a month early, while it could still be outstanding.
  const monthStart = dayjs(now).tz(TZ()).startOf('month').toDate();

  const due = await Payout.find({
    kind: 'advance',
    redactedAt: { $in: [null, undefined] },
    createdAt: { $lt: monthStart },
  });

  let redacted = 0;
  for (const payout of due) {
    payout.reason = undefined;
    payout.notes = undefined;
    if (payout.proof) payout.proof.url = undefined;
    payout.redactedAt = now;
    // eslint-disable-next-line no-await-in-loop
    await payout.save();
    redacted += 1;
  }
  return redacted;
}

/**
 * The whole picture for one period.
 *
 * Every figure is derived here rather than stored, so nothing can drift out
 * of step with the bookings and costs it came from.
 */
export async function financeSummary({ from, to } = {}) {
  const [earnings, costs, payouts] = await Promise.all([
    earningsSummary({ from, to }),
    costSummary({ from, to }),
    payoutSummary({ from, to }),
  ]);

  /* ---- Revenue and profit per client ---- */
  const clients = new Map();
  for (const r of earnings.rows) {
    const id = String(r.familyId || r.family || 'unknown');
    const row = clients.get(id) || {
      clientId: id,
      name: r.family || 'Unknown',
      charged: 0,
      paidToNannies: 0,
      refunded: 0,
      profit: 0,
      bookings: 0,
      days: 0,
    };
    row.charged = round2(row.charged + (r.charged || 0));
    row.paidToNannies = round2(row.paidToNannies + (r.paidToNannies || 0));
    row.refunded = round2(row.refunded + (r.refunded || 0));
    row.profit = round2(row.profit + (r.commission || 0));
    row.bookings += 1;
    row.days += r.completedDays || 0;
    clients.set(id, row);
  }

  /* ---- Revenue and profit per nanny ---- */
  const nannies = new Map();
  const nannyRow = (id, name) => nannies.get(id) || {
    nannyId: id,
    name: name || 'Unknown',
    charged: 0,
    earned: 0,
    profit: 0,
    bookings: 0,
    days: 0,
    missingRate: false,
  };
  for (const r of earnings.rows) {
    const id = String(r.nannyId || r.nanny || 'unknown');
    const row = nannyRow(id, r.nanny);

    // Each nanny is credited with what she herself earned. On a two-nanny
    // booking the whole booking's pay used to land on the first nanny's row
    // and the second nanny had no row at all.
    const shares = new Map((r.nannyShares || []).map((s) => [String(s.nannyId), s.earned]));
    const ownShare = shares.has(id) ? shares.get(id) : (r.paidToNannies || 0);

    row.charged = round2(row.charged + (r.charged || 0));
    row.earned = round2(row.earned + ownShare);
    row.profit = round2(row.profit + (r.commission || 0));
    row.bookings += 1;
    row.days += r.completedDays || 0;
    // One unpriced booking makes her whole row unreliable, so it is carried.
    if (r.missingNannyRate) row.missingRate = true;
    nannies.set(id, row);

    // The second nanny: her own earnings and days. Revenue and profit stay
    // with the booking's row above so they are not counted twice.
    const secondId = r.secondNannyId && String(r.secondNannyId);
    if (secondId && secondId !== id && shares.has(secondId)) {
      const second = nannyRow(secondId, r.secondNanny);
      second.earned = round2(second.earned + shares.get(secondId));
      second.bookings += 1;
      second.days += r.completedDays || 0;
      nannies.set(secondId, second);
    }
  }

  const sortByProfit = (a, b) => b.profit - a.profit;

  /**
   * Gross margin is what the bookings kept. Net is what is left after the
   * costs nobody billed to a booking — and it is the only one of the two
   * that answers "did we make money this month?".
   */
  const grossProfit = round2(earnings.totals.commission);
  const netProfit = round2(grossProfit - costs.total);

  return {
    period: {
      // The label must name the window that was actually queried.
      from: from || dayjs().tz(TZ()).startOf('month').format('YYYY-MM-DD'),
      to: to || dayjs().tz(TZ()).format('YYYY-MM-DD'),
    },

    totals: {
      revenue: round2(earnings.totals.charged),
      paidToNannies: round2(earnings.totals.paidToNannies),
      refunded: round2(earnings.totals.refunded),
      // Overtime is paid by the family to the nanny in person, so it is inside
      // revenue without ever reaching our bank; our part of it is recovered
      // from her payouts. Shown so the bank balance can be reconciled.
      overtimeCollectedByNannies: round2(earnings.totals.overtimeCollectedByNannies || 0),
      overtimeCommission: round2(earnings.totals.overtimeCommission || 0),
      grossProfit,
      costs: costs.total,
      netProfit,
      bookings: earnings.totals.bookings,
      days: earnings.totals.days,
      // What margin survives to the bank, as a share of what was charged.
      netMarginPercent: earnings.totals.charged
        ? Math.round((netProfit / earnings.totals.charged) * 100)
        : 0,
    },

    byClient: [...clients.values()].sort(sortByProfit),
    byNanny: [...nannies.values()].sort(sortByProfit),

    payouts: {
      paid: payouts.paid,
      pending: payouts.pending,
      byStatus: payouts.byStatus,
      byNanny: payouts.byNanny,
    },

    costs: {
      total: costs.total,
      byCategory: costs.byCategory,
      voidedCount: costs.voidedCount,
    },

    // Bookings with no nanny rate recorded overstate profit by whatever she
    // is actually owed, so the figure above is flagged rather than trusted.
    unpriced: earnings.unpriced || [],
  };
}

export default {
  financeSummary, costSummary, payoutSummary, salaryForecast, outstandingAdvances,
};
