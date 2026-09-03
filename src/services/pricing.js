import { getSettings } from './settings.js';
import { round2 } from './policy.js';

/**
 * What a family pays per hour.
 *
 * Pricing is set by the platform, not by the nanny: every family pays the same
 * for the same number of children, whichever nanny they choose. A nanny's own
 * hourlyRate is what she is paid, and is deliberately not what is charged.
 *
 * Two tables — a standard one, and a discounted one for families who have
 * successfully referred someone. The discount runs for a configured number of
 * days, or forever, and can be extended by each additional referral.
 */

/** Used until an admin sets their own, and as the shape of the setting. */
export const DEFAULT_PRICING = {
  // Rp per hour, by number of children.
  standard: { 1: 120000, 2: 160000, 3: 210000 },
  referred: { 1: 80000, 2: 110000, 3: 140000 },
  // Beyond the largest tier, each extra child adds this share of the 1-child
  // price, so a 4th or 5th child is priced rather than silently free.
  extraChildShare: 0.35,
};

export const DEFAULT_REFERRAL_DISCOUNT = {
  // How long discounted pricing lasts after a successful referral.
  validityDays: 30,
  // When true, validityDays is ignored and the discount runs until cancelled.
  neverExpires: false,
  // When true, N successful referrals give N x validityDays.
  stackReferrals: true,
};

/** Read the price table for a given child count from either tier. */
function rateFor(table, children, extraShare) {
  const tiers = Object.keys(table)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  if (!tiers.length) return 0;

  const n = Math.max(1, Number(children) || 1);
  if (table[n] !== undefined) return Number(table[n]);

  // Fewer children than the smallest tier: use the smallest.
  if (n < tiers[0]) return Number(table[tiers[0]]);

  // More children than the largest tier: extend it rather than refuse.
  const top = tiers[tiers.length - 1];
  const extra = n - top;
  const onePerChild = Number(table[tiers[0]]) || 0;
  return round2(Number(table[top]) + extra * onePerChild * extraShare);
}

/**
 * Is this family currently entitled to referred pricing?
 *
 * The discount is a thank-you to the referrer, so it keys off their own
 * successful referrals rather than how they joined.
 */
export function discountStatus(user, discountConfig) {
  const cfg = { ...DEFAULT_REFERRAL_DISCOUNT, ...(discountConfig || {}) };
  const count = user?.referralCount || 0;

  if (!count) return { active: false, reason: 'no_referrals', expiresAt: null };
  if (user?.referralDiscountCancelled) {
    return { active: false, reason: 'cancelled', expiresAt: null };
  }
  if (cfg.neverExpires) return { active: true, reason: 'never_expires', expiresAt: null };

  // Counted from the first referral, so the window is not silently restarted
  // by a later one; stacking extends it instead.
  const since = user?.firstReferralAt || user?.updatedAt || new Date();
  const days = cfg.stackReferrals ? cfg.validityDays * count : cfg.validityDays;
  const expiresAt = new Date(new Date(since).getTime() + days * 86400000);

  return {
    active: expiresAt > new Date(),
    reason: expiresAt > new Date() ? 'active' : 'expired',
    expiresAt,
    days,
    referrals: count,
  };
}

/**
 * The hourly rate for one booking.
 * Returns the rate plus why it was chosen, so the summary can explain itself.
 */
export async function hourlyRateFor({ user, children = 1 }) {
  const settings = await getSettings();
  const pricing = { ...DEFAULT_PRICING, ...(settings.pricing || {}) };
  const discount = { ...DEFAULT_REFERRAL_DISCOUNT, ...(settings.referralDiscount || {}) };

  const status = discountStatus(user, discount);
  const table = status.active ? pricing.referred : pricing.standard;
  const share = pricing.extraChildShare ?? DEFAULT_PRICING.extraChildShare;

  return {
    hourlyRate: rateFor(table, children, share),
    standardRate: rateFor(pricing.standard, children, share),
    discounted: status.active,
    discountExpiresAt: status.expiresAt,
    children: Math.max(1, Number(children) || 1),
  };
}

export default { hourlyRateFor, discountStatus, DEFAULT_PRICING, DEFAULT_REFERRAL_DISCOUNT };
