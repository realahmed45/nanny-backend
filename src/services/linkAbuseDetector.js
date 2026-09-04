import { ShareLink, ShareLinkClick, LinkAbuseAlert, User, ABUSE_KIND } from '../models/index.js';
import { USER_ROLE } from '../utils/constants.js';

/**
 * OR9 — patterns worth a human look.
 *
 * Nothing here blocks anything, by design. An automatic block on a false
 * positive costs a real referrer their reward with no way for them to notice
 * and no way for us to find out. A flagged alert costs somebody a minute.
 *
 * Every threshold is env-overridable, because what counts as suspicious in
 * Bali in December is not what counts in a quiet week.
 */

const num = (envKey, fallback) => {
  const v = Number(process.env[envKey]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const THRESHOLDS = {
  velocityClickers: () => num('ABUSE_VELOCITY_CLICKERS', 10),
  velocityWindowMin: () => num('ABUSE_VELOCITY_WINDOW_MIN', 10),
  burstSeconds: () => num('ABUSE_BURST_SECONDS', 2),
  repeatLinks: () => num('ABUSE_REPEAT_LINKS', 4),
  repeatWindowDays: () => num('ABUSE_REPEAT_WINDOW_DAYS', 7),
  snipeHours: () => num('ABUSE_SNIPE_HOURS', 48),
  conversionCeiling: () => Number(process.env.ABUSE_CONVERSION_CEILING) || 0.8,
  conversionMinSample: () => num('ABUSE_CONVERSION_MIN_SAMPLE', 8),
};

const today = () => new Date().toISOString().slice(0, 10);

/** One alert per pattern per day, rather than one per sweep. */
async function raise({ kind, subjectType, subject, severity, detail, evidence, sharer }) {
  return LinkAbuseAlert.findOneAndUpdate(
    { kind, subject: String(subject), day: today() },
    {
      $setOnInsert: {
        kind, subjectType, subject: String(subject), day: today(),
        severity, detail, evidence, sharer, status: 'open',
      },
    },
    { upsert: true, new: true },
  ).catch(() => null);
}

/** Many distinct numbers on one link in minutes — a blast, not word of mouth. */
async function checkMassBlast() {
  const window = new Date(Date.now() - THRESHOLDS.velocityWindowMin() * 60000);
  const rows = await ShareLinkClick.aggregate([
    { $match: { createdAt: { $gte: window }, clickerPhone: { $ne: '' } } },
    { $group: { _id: '$linkId', phones: { $addToSet: '$clickerPhone' }, sharer: { $first: '$sharer' } } },
    { $project: { n: { $size: '$phones' }, sharer: 1 } },
    { $match: { n: { $gte: THRESHOLDS.velocityClickers() } } },
  ]);

  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await raise({
      kind: ABUSE_KIND.MASS_BLAST,
      subjectType: 'link',
      subject: r._id,
      severity: 'medium',
      detail: `${r.n} different numbers opened this link within ${THRESHOLDS.velocityWindowMin()} minutes.`,
      evidence: { clickers: r.n },
      sharer: r.sharer,
    });
  }
  return rows.length;
}

/** Clicks closer together than a person can tap are automation. */
async function checkBurst() {
  const since = new Date(Date.now() - 24 * 3600000);
  const clicks = await ShareLinkClick.find({ createdAt: { $gte: since } })
    .sort({ linkId: 1, createdAt: 1 })
    .select('linkId createdAt sharer');

  const gap = THRESHOLDS.burstSeconds() * 1000;
  const flagged = new Set();

  for (let i = 1; i < clicks.length; i += 1) {
    const prev = clicks[i - 1];
    const cur = clicks[i];
    if (cur.linkId !== prev.linkId) continue;
    if (new Date(cur.createdAt) - new Date(prev.createdAt) > gap) continue;
    flagged.add(cur.linkId);
  }

  for (const linkId of flagged) {
    const sample = clicks.find((c) => c.linkId === linkId);
    // eslint-disable-next-line no-await-in-loop
    await raise({
      kind: ABUSE_KIND.BURST,
      subjectType: 'link',
      subject: linkId,
      severity: 'low',
      detail: `Clicks less than ${THRESHOLDS.burstSeconds()}s apart — likely automated.`,
      sharer: sample?.sharer,
    });
  }
  return flagged.size;
}

/** One number opening many links from the same sharer looks arranged. */
async function checkCollusion() {
  const since = new Date(Date.now() - THRESHOLDS.repeatWindowDays() * 86400000);
  const rows = await ShareLinkClick.aggregate([
    { $match: { createdAt: { $gte: since }, clickerPhone: { $ne: '' } } },
    { $group: { _id: { phone: '$clickerPhone', sharer: '$sharer' }, links: { $addToSet: '$linkId' } } },
    { $project: { n: { $size: '$links' } } },
    { $match: { n: { $gte: THRESHOLDS.repeatLinks() } } },
  ]);

  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await raise({
      kind: ABUSE_KIND.COLLUSION,
      subjectType: 'phone',
      subject: r._id.phone,
      severity: 'medium',
      detail: `Opened ${r.n} different links from the same sharer in ${THRESHOLDS.repeatWindowDays()} days.`,
      evidence: { links: r.n },
      sharer: r._id.sharer,
    });
  }
  return rows.length;
}

/**
 * A referrer swapped moments before a first booking.
 *
 * This is the cost of OR3 made visible: last-touch means credit can be taken,
 * and because credit is never split there is no way to compensate the robbed
 * referrer afterwards. So it is flagged before anyone asks.
 */
export async function checkCreditSniping(user, booking) {
  const history = user?.referralAttributionHistory || [];
  const swap = [...history].reverse().find((h) => h.reason === 'later_referral');
  if (!swap) return null;

  const hours = (new Date() - new Date(swap.retiredAt)) / 3600000;
  if (hours > THRESHOLDS.snipeHours()) return null;

  return raise({
    kind: ABUSE_KIND.CREDIT_SNIPING,
    subjectType: 'phone',
    subject: user.phone,
    severity: 'high',
    detail: `Referrer changed ${Math.round(hours)}h before booking #${booking?.bookingNumber || '—'}. `
      + `${swap.referrerName || 'The previous referrer'} lost the claim and cannot be compensated.`,
    evidence: {
      previousReferrer: swap.referrerName,
      previousCode: swap.referrerCode,
      newReferrer: user.referralAttribution?.referrerName,
      bookingNumber: booking?.bookingNumber,
    },
    sharer: user.referralAttribution?.referrer,
  });
}

/** A click-to-booking rate that good would be remarkable. */
async function checkConversionRate() {
  const links = await ShareLink.find({ 'conversions.0': { $exists: true } })
    .select('linkId sharer conversions openCount');

  let flagged = 0;
  for (const link of links) {
    const conversions = (link.conversions || []).length;
    // eslint-disable-next-line no-await-in-loop
    const clicks = await ShareLinkClick.countDocuments({ linkId: link.linkId });
    if (clicks < THRESHOLDS.conversionMinSample()) continue;

    const rate = conversions / clicks;
    if (rate < THRESHOLDS.conversionCeiling()) continue;

    flagged += 1;
    // eslint-disable-next-line no-await-in-loop
    await raise({
      kind: ABUSE_KIND.CONVERSION_TOO_HIGH,
      subjectType: 'link',
      subject: link.linkId,
      severity: 'medium',
      detail: `${Math.round(rate * 100)}% of clicks became bookings across ${clicks} clicks.`,
      evidence: { clicks, conversions },
      sharer: link.sharer,
    });
  }
  return flagged;
}

/** A nanny's own number clicking a family's link, and similar. */
async function checkInsiderClicks() {
  const since = new Date(Date.now() - 24 * 3600000);
  const clicks = await ShareLinkClick.find({
    createdAt: { $gte: since }, clickerPhone: { $ne: '' },
  }).select('clickerPhone linkId sharer');

  let flagged = 0;
  for (const click of clicks) {
    // eslint-disable-next-line no-await-in-loop
    const insider = await User.findOne({ phone: click.clickerPhone, role: USER_ROLE.NANNY })
      .select('_id nickname');
    if (!insider) continue;

    flagged += 1;
    // eslint-disable-next-line no-await-in-loop
    await raise({
      kind: ABUSE_KIND.INSIDER_CLICK,
      subjectType: 'phone',
      subject: click.clickerPhone,
      severity: 'low',
      detail: 'A nanny account opened a referral link.',
      evidence: { linkId: click.linkId },
      sharer: click.sharer,
    });
  }
  return flagged;
}

/** One sharer minting links compulsively. */
async function checkLinkFlood() {
  const since = new Date(Date.now() - 24 * 3600000);
  const rows = await ShareLink.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $group: { _id: '$sharer', n: { $sum: 1 } } },
    { $match: { n: { $gte: 20 } } },
  ]);

  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await raise({
      kind: ABUSE_KIND.LINK_FLOOD,
      subjectType: 'sharer',
      subject: r._id,
      severity: 'low',
      detail: `Minted ${r.n} links in 24 hours.`,
      sharer: r._id,
    });
  }
  return rows.length;
}

/** Self-referral attempts, which the engine already refuses to credit. */
async function checkSelfReferral() {
  const since = new Date(Date.now() - 24 * 3600000);
  const clicks = await ShareLinkClick.find({
    createdAt: { $gte: since }, skipReason: 'self_click',
  }).select('clickerPhone linkId sharer');

  for (const click of clicks) {
    // eslint-disable-next-line no-await-in-loop
    await raise({
      kind: ABUSE_KIND.SELF_REFERRAL,
      subjectType: 'phone',
      subject: click.clickerPhone,
      severity: 'low',
      detail: 'Sharer opened their own link.',
      evidence: { linkId: click.linkId },
      sharer: click.sharer,
    });
  }
  return clicks.length;
}

/** Run every detector. Never throws — a failed sweep must not stop the app. */
export async function runAbuseSweep() {
  const results = {};
  const checks = [
    ['massBlast', checkMassBlast],
    ['burst', checkBurst],
    ['collusion', checkCollusion],
    ['conversionRate', checkConversionRate],
    ['insiderClicks', checkInsiderClicks],
    ['linkFlood', checkLinkFlood],
    ['selfReferral', checkSelfReferral],
  ];

  for (const [name, fn] of checks) {
    try {
      // eslint-disable-next-line no-await-in-loop
      results[name] = await fn();
    } catch (err) {
      console.error(`[abuse] ${name} failed: ${err.message}`);
      results[name] = 0;
    }
  }
  return results;
}

export default { runAbuseSweep, checkCreditSniping, THRESHOLDS };
