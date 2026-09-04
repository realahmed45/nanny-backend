import { User, ShareLink, ShareLinkClick, SKIP_REASON } from '../models/index.js';
import { findLink } from './shareLink.js';

/**
 * Who introduced whom, when the claim expires, and when it settles for good.
 *
 * The ten rules this enforces are business decisions, not implementation
 * details, so each is named where it is applied:
 *
 *   OR1  every click is recorded, with the clicker's number when known
 *   OR2  a person may be referred many times while still a lead
 *   OR3  exactly one referrer, ever — last click wins and erases the previous
 *   OR4  credit is stamped at the first *written* interaction, never before
 *   OR5  30 days from when the link was *created*
 *   OR6  links are unlimited-use
 *   OR7  direct sharer only — no chains, no levels
 *   OR8  chain depth is unrecoverable; accepted
 *   OR9  overuse raises an alarm, never a block
 *   OR10 attribution freezes at the first paid booking, permanently
 *
 * The engine is passive: it never polls and never intercepts. It exposes
 * entry points and waits to be called. A missed call site means that stage
 * silently never happens.
 */

/** OR7: what a referrer earns here is the discount, applied by pricing.js. */
export const PAYS_COMMISSION = false;

/**
 * OR4 + OR3 — they wrote to us, so resolve their one referrer.
 *
 * Called on every inbound message. Cheap on the common path: a frozen or
 * unreferred person exits in one query.
 */
export async function creditOnInteraction(user, { phone } = {}) {
  if (!user) return { changed: false, reason: 'no_user' };

  const attribution = user.referralAttribution || {};

  // OR10: settled is settled. Later clicks are still recorded, but they are
  // marked frozen rather than left looking like nobody ever replied.
  if (attribution.status === 'frozen') {
    await markClicks(phone || user.phone, SKIP_REASON.FROZEN, { becameInteraction: true });
    return { changed: false, reason: 'frozen' };
  }

  const digits = String(phone || user.phone || '').replace(/\D/g, '');
  if (!digits) return { changed: false, reason: 'no_phone' };

  // The most recent click that could still earn anything.
  const clicks = await ShareLinkClick.find({ clickerPhone: digits })
    .sort({ createdAt: -1 })
    .limit(20);

  if (!clicks.length) return { changed: false, reason: 'no_clicks' };

  let winner = null;
  for (const click of clicks) {
    // eslint-disable-next-line no-await-in-loop
    const link = await ShareLink.findById(click.shareLink);
    if (!link) continue;

    // The sharer cannot refer themselves.
    if (String(link.sharer) === String(user._id)) {
      click.skipReason = SKIP_REASON.SELF_CLICK;
      click.becameInteraction = true;
      // eslint-disable-next-line no-await-in-loop
      await click.save();
      continue;
    }

    // OR5, checked against the link's own deadline.
    if (!link.isLive()) {
      click.skipReason = SKIP_REASON.OUTSIDE_WINDOW;
      click.becameInteraction = true;
      // eslint-disable-next-line no-await-in-loop
      await click.save();
      continue;
    }

    winner = { click, link };
    break;
  }

  if (!winner) return { changed: false, reason: 'no_live_click' };

  const { click, link } = winner;

  // OR2 + OR3: already credited to this same referrer is a no-op, not a
  // second claim; a different referrer takes it and retires the incumbent.
  const incumbent = attribution.referrer ? String(attribution.referrer) : null;
  if (incumbent && incumbent === String(link.sharer)) {
    click.skipReason = SKIP_REASON.ALREADY_CREDITED;
    click.becameInteraction = true;
    await click.save();
    return { changed: false, reason: 'same_referrer' };
  }

  const referrer = await User.findById(link.sharer).select('_id fullName referralCode referralCount firstReferralAt');
  if (!referrer) return { changed: false, reason: 'referrer_missing' };

  // OR3: the previous claim is erased, but the record of it is not.
  if (incumbent) {
    user.referralAttributionHistory = user.referralAttributionHistory || [];
    user.referralAttributionHistory.push({
      referrer: attribution.referrer,
      referrerCode: attribution.referrerCode,
      referrerName: attribution.referrerName,
      linkId: attribution.linkId,
      creditedAt: attribution.creditedAt,
      retiredAt: new Date(),
      reason: 'later_referral',
      heldClaim: false,
    });

    // The losing click says why it lost, rather than looking un-replied.
    await ShareLinkClick.updateMany(
      { clickerPhone: digits, linkId: attribution.linkId, skipReason: SKIP_REASON.WON },
      { $set: { skipReason: SKIP_REASON.SUPERSEDED } },
    );

    // The old referrer loses the count they were given.
    await User.updateOne(
      { _id: attribution.referrer, referralCount: { $gt: 0 } },
      { $inc: { referralCount: -1 } },
    );
  }

  user.referralAttribution = {
    status: 'credited',
    referrer: referrer._id,
    referrerCode: referrer.referralCode,
    referrerName: referrer.fullName,
    linkId: link.linkId,
    shareLink: link._id,
    clickedAt: click.createdAt,
    creditedAt: new Date(),
    windowExpiresAt: link.expiresAt,
  };

  // Kept in step for the older readers (pricing, the referrals report).
  user.referredBy = referrer._id;
  await user.save();

  click.becameInteraction = true;
  click.confirmedByMessageAt = click.confirmedByMessageAt || new Date();
  click.skipReason = SKIP_REASON.WON;
  await click.save();

  referrer.referralCount = (referrer.referralCount || 0) + 1;
  if (!referrer.firstReferralAt) referrer.firstReferralAt = new Date();
  await referrer.save();

  return { changed: true, referrer, link, reason: incumbent ? 'replaced' : 'credited' };
}

/**
 * OR10 — a booking was actually paid, so the claim settles for good.
 *
 * Called when payment becomes real, never at booking creation: freezing on an
 * unpaid booking would let a cancelled one lock someone out of attribution,
 * or be used to block a rival's referral.
 *
 * Safe to call twice for one booking — the conversion is keyed on it.
 */
export async function resolveOnBooking(user, booking) {
  if (!user || !booking) return { changed: false, reason: 'missing' };

  const attribution = user.referralAttribution || {};
  if (attribution.status === 'frozen') return { changed: false, reason: 'already_frozen' };
  if (attribution.status !== 'credited') return { changed: false, reason: 'not_credited' };

  // OR5 re-checked at purchase time: a window that lapsed between the reply
  // and the payment earns nothing.
  const deadline = attribution.windowExpiresAt;
  if (deadline && new Date(deadline) < new Date()) {
    return expireAttribution(user, 'window_lapsed');
  }

  const link = attribution.shareLink ? await ShareLink.findById(attribution.shareLink) : null;

  if (link) {
    // Idempotent: one conversion per booking, however often this runs.
    const already = (link.conversions || []).some(
      (c) => String(c.bookingId) === String(booking._id),
    );
    if (!already) {
      link.conversions.push({
        user: user._id,
        phone: user.phone,
        bookingId: booking._id,
        bookingNumber: booking.bookingNumber,
        amount: booking.totalAmount,
        at: new Date(),
      });
      await link.save();
    }
  }

  user.referralAttribution = {
    ...(attribution.toObject ? attribution.toObject() : attribution),
    status: 'frozen',
    frozenAt: new Date(),
    frozenByBooking: booking._id,
    frozenByBookingNumber: booking.bookingNumber,
  };

  user.referralAttributionHistory = user.referralAttributionHistory || [];
  user.referralAttributionHistory.push({
    referrer: attribution.referrer,
    referrerCode: attribution.referrerCode,
    referrerName: attribution.referrerName,
    linkId: attribution.linkId,
    creditedAt: attribution.creditedAt,
    retiredAt: new Date(),
    reason: 'frozen',
    heldClaim: true,
  });

  await user.save();

  return { changed: true, referrer: attribution.referrer, reason: 'frozen' };
}

/** OR5 — the window ran out with no booking. */
export async function expireAttribution(user, reason = 'expired') {
  const attribution = user.referralAttribution || {};
  if (attribution.status !== 'credited') return { changed: false, reason: 'not_credited' };

  user.referralAttributionHistory = user.referralAttributionHistory || [];
  user.referralAttributionHistory.push({
    referrer: attribution.referrer,
    referrerCode: attribution.referrerCode,
    referrerName: attribution.referrerName,
    linkId: attribution.linkId,
    creditedAt: attribution.creditedAt,
    retiredAt: new Date(),
    reason: 'expired',
    heldClaim: false,
  });

  user.referralAttribution = {
    ...(attribution.toObject ? attribution.toObject() : attribution),
    status: 'expired',
    expiredAt: new Date(),
  };

  // The referrer keeps nothing from a claim that never converted.
  if (attribution.referrer) {
    await User.updateOne(
      { _id: attribution.referrer, referralCount: { $gt: 0 } },
      { $inc: { referralCount: -1 } },
    );
  }

  await user.save();
  return { changed: true, reason };
}

/**
 * The sweep. A window can lapse while nothing at all happens — they clicked,
 * replied, then never booked, and nothing else would ever notice.
 */
export async function expireStale(now = new Date()) {
  const stale = await User.find({
    'referralAttribution.status': 'credited',
    'referralAttribution.windowExpiresAt': { $lte: now },
  }).limit(500);

  let expired = 0;
  for (const user of stale) {
    // eslint-disable-next-line no-await-in-loop
    const result = await expireAttribution(user, 'swept').catch(() => ({ changed: false }));
    if (result.changed) expired += 1;
  }
  return expired;
}

/** Stamp a reason onto this phone's clicks, so none reads as "no reply yet". */
async function markClicks(phone, skipReason, extra = {}) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return;
  await ShareLinkClick.updateMany(
    { clickerPhone: digits, skipReason: { $ne: SKIP_REASON.WON } },
    { $set: { skipReason, ...extra } },
  ).catch(() => {});
}

export default {
  creditOnInteraction, resolveOnBooking, expireAttribution, expireStale, PAYS_COMMISSION,
};
