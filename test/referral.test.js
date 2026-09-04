import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, clearDb } from './helpers.js';

/**
 * The referral attribution engine, walked end to end.
 *
 * Each test names the owner rule it pins. These are business decisions rather
 * than implementation details, so they are asserted on behaviour — never on a
 * constant copied out of the file under test, which would agree with a bug
 * just as readily as with a fix.
 */

before(async () => {
  process.env.PUBLIC_BASE_URL = 'https://test.mynanny.local';
  await setupDb();
});
after(async () => { await teardownDb(); });
beforeEach(async () => { await clearDb(); });

const mkUser = async (phone, name, code) => {
  const { User } = await import('../src/models/index.js');
  return User.create({
    role: 'family', phone, fullName: name, email: `${code.toLowerCase()}@test.local`,
    emailVerified: true, registrationComplete: true, referralCode: code,
  });
};

const svc = () => import('../src/services/shareLink.js');
const engine = () => import('../src/services/referralAttribution.js');

test('OR5/OR6: a minted link carries a 30-day deadline and a tracked URL', async () => {
  const { createShareLink } = await svc();
  const sharer = await mkUser('62900000001', 'Sarah Alpha', 'ALPHA111');

  const link = await createShareLink({ sharer });

  const days = Math.round((link.expiresAt - Date.now()) / 86400000);
  assert.equal(days, 30, 'the window runs from creation, not from the click');
  assert.ok(link.trackedUrl, 'without a tracked URL no click is ever visible');
  assert.equal(link.status, 'active');
  assert.deepEqual(link.conversions, [], 'OR6: a link converts many times, so this is a list');
});

test('OR1: one human tap logs one row, not two', async () => {
  const { createShareLink, recordClick, recordInboundOpen } = await svc();
  const { ShareLink, ShareLinkClick } = await import('../src/models/index.js');

  const sharer = await mkUser('62900000001', 'Sarah Alpha', 'ALPHA111');
  const link = await createShareLink({ sharer });

  // The redirect fires first and cannot know a phone number yet.
  await recordClick(link.linkId, '', { source: 'web_redirect' });

  let clicks = await ShareLinkClick.find({ linkId: link.linkId });
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].clickerPhone, '', 'the number is not knowable at redirect time');

  // The prefilled message then arrives carrying the same code.
  await recordInboundOpen('62900000100', `nanny ${link.linkId}`);

  clicks = await ShareLinkClick.find({ linkId: link.linkId });
  assert.equal(clicks.length, 1, 'the message adopts the redirect row rather than duplicating it');
  assert.equal(clicks[0].clickerPhone, '62900000100');
  assert.equal(clicks[0].matchConfidence, 'certain');
  assert.ok(clicks[0].confirmedByMessageAt);

  const fresh = await ShareLink.findById(link._id);
  assert.equal(fresh.openCount, 1, 'one tap counts once');
});

test('OR4: credit is stamped at the first written interaction', async () => {
  const { createShareLink, recordClick, recordInboundOpen } = await svc();
  const { creditOnInteraction } = await engine();
  const { User } = await import('../src/models/index.js');

  const sharer = await mkUser('62900000001', 'Sarah Alpha', 'ALPHA111');
  const guest = await mkUser('62900000100', 'Maya Guest', 'GUEST999');
  const link = await createShareLink({ sharer });

  // A tap alone earns nothing.
  await recordClick(link.linkId, '', { source: 'web_redirect' });
  let g = await User.findById(guest._id);
  assert.equal(g.referralAttribution.status, 'none', 'no message, no credit');

  await recordInboundOpen(guest.phone, `nanny ${link.linkId}`);
  await creditOnInteraction(await User.findById(guest._id), { phone: guest.phone });

  g = await User.findById(guest._id);
  assert.equal(g.referralAttribution.status, 'credited');
  assert.equal(g.referralAttribution.referrerCode, 'ALPHA111');
  assert.equal(String(g.referredBy), String(sharer._id), 'legacy readers stay in step');

  const s = await User.findById(sharer._id);
  assert.equal(s.referralCount, 1);
});

test('OR3: the last click wins and erases the previous claim', async () => {
  const { createShareLink, recordClick, recordInboundOpen } = await svc();
  const { creditOnInteraction } = await engine();
  const { User, ShareLinkClick } = await import('../src/models/index.js');

  const alpha = await mkUser('62900000001', 'Sarah Alpha', 'ALPHA111');
  const beta = await mkUser('62900000002', 'Bruno Beta', 'BETA222');
  const guest = await mkUser('62900000100', 'Maya Guest', 'GUEST999');

  const linkA = await createShareLink({ sharer: alpha });
  await recordClick(linkA.linkId, '', {});
  await recordInboundOpen(guest.phone, `nanny ${linkA.linkId}`);
  await creditOnInteraction(await User.findById(guest._id), { phone: guest.phone });

  const linkB = await createShareLink({ sharer: beta });
  await recordClick(linkB.linkId, '', {});
  await recordInboundOpen(guest.phone, `nanny ${linkB.linkId}`);
  await creditOnInteraction(await User.findById(guest._id), { phone: guest.phone });

  const g = await User.findById(guest._id);
  assert.equal(g.referralAttribution.referrerCode, 'BETA222', 'exactly one referrer, the latest');

  const retired = g.referralAttributionHistory.find((h) => h.referrerCode === 'ALPHA111');
  assert.ok(retired, 'the erased claim is still recorded');
  assert.equal(retired.reason, 'later_referral');
  assert.equal(retired.heldClaim, false, 'credit is never split');

  const losing = await ShareLinkClick.findOne({ linkId: linkA.linkId });
  assert.equal(losing.skipReason, 'superseded', 'the losing click says why it lost');

  const a = await User.findById(alpha._id);
  assert.equal(a.referralCount, 0, 'the erased referrer loses the count too');
});

test('OR10: attribution freezes at the first paid booking, and only then', async () => {
  const { createShareLink, recordClick, recordInboundOpen } = await svc();
  const { creditOnInteraction, resolveOnBooking } = await engine();
  const { User, Booking, ShareLink } = await import('../src/models/index.js');

  const sharer = await mkUser('62900000001', 'Sarah Alpha', 'ALPHA111');
  const guest = await mkUser('62900000100', 'Maya Guest', 'GUEST999');
  const link = await createShareLink({ sharer });

  await recordClick(link.linkId, '', {});
  await recordInboundOpen(guest.phone, `nanny ${link.linkId}`);
  await creditOnInteraction(await User.findById(guest._id), { phone: guest.phone });

  const booking = await Booking.create({
    bookingNumber: 'T-1', family: guest._id, status: 'pending_payment',
    startDate: '2026-12-01', endDate: '2026-12-01', startTime: '09:00', hoursPerDay: 2,
    hourlyRate: 120000, totalAmount: 240000, paymentStatus: 'payment_in_process',
  });

  let g = await User.findById(guest._id);
  assert.equal(g.referralAttribution.status, 'credited', 'an unpaid booking settles nothing');

  await resolveOnBooking(await User.findById(guest._id), booking);

  g = await User.findById(guest._id);
  assert.equal(g.referralAttribution.status, 'frozen');
  assert.equal(g.referralAttribution.frozenByBookingNumber, 'T-1');

  const l = await ShareLink.findById(link._id);
  assert.equal(l.conversions.length, 1);
});

test('a payment confirmed twice changes nothing the second time', async () => {
  const { createShareLink, recordClick, recordInboundOpen } = await svc();
  const { creditOnInteraction, resolveOnBooking } = await engine();
  const { User, Booking, ShareLink } = await import('../src/models/index.js');

  const sharer = await mkUser('62900000001', 'Sarah Alpha', 'ALPHA111');
  const guest = await mkUser('62900000100', 'Maya Guest', 'GUEST999');
  const link = await createShareLink({ sharer });

  await recordClick(link.linkId, '', {});
  await recordInboundOpen(guest.phone, `nanny ${link.linkId}`);
  await creditOnInteraction(await User.findById(guest._id), { phone: guest.phone });

  const booking = await Booking.create({
    bookingNumber: 'T-2', family: guest._id, status: 'upcoming',
    startDate: '2026-12-01', endDate: '2026-12-01', startTime: '09:00', hoursPerDay: 2,
    hourlyRate: 120000, totalAmount: 240000, paymentStatus: 'payment_completed',
  });

  await resolveOnBooking(await User.findById(guest._id), booking);
  await resolveOnBooking(await User.findById(guest._id), booking);

  const l = await ShareLink.findById(link._id);
  assert.equal(l.conversions.length, 1, 'the conversion is keyed on the booking');
});

test('a frozen person clicking again reads "frozen", not "never replied"', async () => {
  const { createShareLink, recordClick, recordInboundOpen } = await svc();
  const { creditOnInteraction, resolveOnBooking } = await engine();
  const { User, Booking, ShareLinkClick } = await import('../src/models/index.js');

  const alpha = await mkUser('62900000001', 'Sarah Alpha', 'ALPHA111');
  const gamma = await mkUser('62900000003', 'Cara Gamma', 'GAMMA333');
  const guest = await mkUser('62900000100', 'Maya Guest', 'GUEST999');

  const linkA = await createShareLink({ sharer: alpha });
  await recordClick(linkA.linkId, '', {});
  await recordInboundOpen(guest.phone, `nanny ${linkA.linkId}`);
  await creditOnInteraction(await User.findById(guest._id), { phone: guest.phone });

  const booking = await Booking.create({
    bookingNumber: 'T-3', family: guest._id, status: 'upcoming',
    startDate: '2026-12-01', endDate: '2026-12-01', startTime: '09:00', hoursPerDay: 2,
    hourlyRate: 120000, totalAmount: 240000, paymentStatus: 'payment_completed',
  });
  await resolveOnBooking(await User.findById(guest._id), booking);

  const linkC = await createShareLink({ sharer: gamma });
  await recordClick(linkC.linkId, '', {});
  await recordInboundOpen(guest.phone, `nanny ${linkC.linkId}`);
  await creditOnInteraction(await User.findById(guest._id), { phone: guest.phone });

  const g = await User.findById(guest._id);
  assert.equal(g.referralAttribution.referrerCode, 'ALPHA111', 'frozen means frozen');

  const click = await ShareLinkClick.findOne({ linkId: linkC.linkId });
  assert.equal(click.skipReason, 'frozen');
  assert.equal(click.becameInteraction, true, 'they did reply — the claim was simply settled');
});

test('OR5: the sweep expires a window that lapsed with no booking', async () => {
  const { createShareLink, recordClick, recordInboundOpen, expireLinks } = await svc();
  const { creditOnInteraction, expireStale } = await engine();
  const { User, ShareLink } = await import('../src/models/index.js');

  const sharer = await mkUser('62900000001', 'Sarah Alpha', 'ALPHA111');
  const guest = await mkUser('62900000100', 'Maya Guest', 'GUEST999');
  const link = await createShareLink({ sharer });

  await recordClick(link.linkId, '', {});
  await recordInboundOpen(guest.phone, `nanny ${link.linkId}`);
  await creditOnInteraction(await User.findById(guest._id), { phone: guest.phone });

  const yesterday = new Date(Date.now() - 86400000);
  await User.updateOne({ _id: guest._id },
    { $set: { 'referralAttribution.windowExpiresAt': yesterday } });
  await ShareLink.updateOne({ _id: link._id }, { $set: { expiresAt: yesterday } });

  const expired = await expireStale();
  await expireLinks();

  assert.equal(expired, 1);
  const g = await User.findById(guest._id);
  assert.equal(g.referralAttribution.status, 'expired');
  assert.equal((await ShareLink.findById(link._id)).status, 'expired');

  const s = await User.findById(sharer._id);
  assert.equal(s.referralCount, 0, 'a claim that never converted earns nothing');
});

test('a sharer cannot refer themselves', async () => {
  const { createShareLink, recordClick } = await svc();
  const { ShareLinkClick } = await import('../src/models/index.js');

  const sharer = await mkUser('62900000001', 'Sarah Alpha', 'ALPHA111');
  const link = await createShareLink({ sharer });

  await recordClick(link.linkId, sharer.phone, { source: 'inbound_message' });

  const click = await ShareLinkClick.findOne({ linkId: link.linkId });
  assert.equal(click.skipReason, 'self_click');
});

test('an ordinary message is never mistaken for a code', async () => {
  const { parseLinkId, createShareLink } = await svc();
  const sharer = await mkUser('62900000001', 'Sarah Alpha', 'ALPHA111');
  const link = await createShareLink({ sharer });

  assert.equal(parseLinkId('nanny'), null, 'the trigger word is not a code');
  assert.equal(parseLinkId('hi there, I need a nanny tomorrow'), null);
  assert.equal(parseLinkId(''), null);
  assert.equal(parseLinkId(`nanny ${link.linkId}`), link.linkId);
  assert.equal(parseLinkId(`[ref:${link.linkId}]`), link.linkId, 'the older marker still parses');
});

test('a code arriving with path characters cannot escape the lookup', async () => {
  const { canonCode } = await svc();
  // Express decodes %2F inside a route parameter, so this shape does arrive.
  assert.equal(canonCode('../../etc/passwd'), 'ETCPASSWD');
  assert.equal(canonCode('ABC/../DEF'), 'ABCDEF');
  assert.equal(canonCode(''), '');
});
