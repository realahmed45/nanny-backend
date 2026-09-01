import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dayjs from 'dayjs';
import { setupDb, teardownDb, clearDb, say, latestOtp, messagesTo } from './helpers.js';

const FAMILY = '971500000001';
const NANNY = '971500000002';

before(async () => { await setupDb(); });
after(async () => { await teardownDb(); });
beforeEach(async () => { await clearDb(); });

/** Register + verify a nanny, then approve her so she is bookable. */
async function createVerifiedNanny(phone = NANNY, { rate = 25, name = 'Maria Grook', email = null } = {}) {
  const address = email || `nanny${phone}@email.com`;
  const { User } = await import('../src/models/index.js');
  const { NANNY_STATUS, USER_ROLE } = await import('../src/utils/constants.js');

  await say(phone, 'nanny');
  await say(phone, '2');            // I'm a nanny
  await say(phone, name);
  await say(phone, address);
  await say(phone, await latestOtp(phone));
  await say(phone, '24');           // age
  await say(phone, '5');            // experience
  await say(phone, '1,2');          // English, Arabic
  await say(phone, '4');            // English rating
  await say(phone, '5');            // Arabic rating
  await say(phone, '1,3');          // Cooking, Newborn Care
  await say(phone, '4');            // Cooking rating
  await say(phone, '4');            // Newborn Care rating
  await say(phone, `$${rate}`);
  await say(phone, '1');            // CPR yes
  await say(phone, '', { mediaUrl: 'https://cdn/cpr.jpg' });
  await say(phone, '', { mediaUrl: 'https://cdn/id-front.jpg' });
  await say(phone, '', { mediaUrl: 'https://cdn/id-back.jpg' });
  await say(phone, 'A 678, Block C');
  await say(phone, 'https://maps.google.com/?q=25,55');
  await say(phone, '', { mediaUrl: 'https://cdn/photo.jpg' });
  await say(phone, '1,2,3,4,5,6,7');  // all week
  await say(phone, '9:00 AM');
  await say(phone, '10');           // up to 24h/day

  const nanny = await User.findOne({ phone, role: USER_ROLE.NANNY });
  nanny.nannyStatus = NANNY_STATUS.VERIFIED;
  nanny.backgroundCheckPassed = true;
  await nanny.save();
  return nanny;
}

/** Walk a family through registration and a single-day booking up to payment. */
async function familyBookingUpToListing(phone = FAMILY, { date = null } = {}) {
  const target = date || dayjs().add(10, 'day').format('YYYY-MM-DD');

  await say(phone, 'nanny');
  await say(phone, '1');            // I'm a family
  await say(phone, '1');            // Find a Nanny
  await say(phone, 'Sarah Johnson');
  await say(phone, 'sarah@email.com');
  await say(phone, await latestOtp(phone));
  await say(phone, 'https://maps.google.com/?q=25.2,55.3');
  await say(phone, 'Downtown Dubai');
  await say(phone, '2');            // don't save address
  await say(phone, '1');            // single day
  await say(phone, target);
  // Booking for today triggers the emergency question; answer it.
  if (target === dayjs().format('YYYY-MM-DD')) await say(phone, '2');
  await say(phone, '9 AM');
  await say(phone, '2');            // two hours
  await say(phone, '1 2');          // English, Arabic (space-separated)
  await say(phone, '1 3');          // Cooking, Newborn Care
  await say(phone, '1');            // one child
  await say(phone, 'Emma');
  await say(phone, '4 years');
  await say(phone, 'Peanut allergy');
  await say(phone, 'Vegetarian');
  return say(phone, 'None');        // other instructions -> summary
}

/**
 * Walk the manual-transfer payment: upload the ID pair, send the receipt
 * screenshot, then have an admin approve it (which is what releases the
 * request to the nanny). Returns the booking.
 */
async function payAndApprove(phone = FAMILY, { approve = true } = {}) {
  const { Booking } = await import('../src/models/index.js');
  const { Payment } = await import('../src/models/Payment.js');

  await say(phone, '1');                                   // start payment
  await say(phone, '', { mediaUrl: 'https://cdn/id-front.jpg' });
  await say(phone, '', { mediaUrl: 'https://cdn/id-back.jpg' });
  await say(phone, '', { mediaUrl: 'https://cdn/receipt.jpg' });   // proof

  const booking = await Booking.findOne({}).sort({ createdAt: -1 });
  if (!approve) return booking;

  const payment = await Payment.findOne({ booking: booking._id, kind: 'booking' });
  await approvePaymentAsAdmin(payment);
  return Booking.findById(booking._id);
}

/** Mimic the admin approving a transfer, including the nanny hand-off. */
async function approvePaymentAsAdmin(payment) {
  const { approveTransfer } = await import('../src/services/payments.js');
  const { openNannyResponseWindow } = await import('../src/services/booking.js');
  const { setNannyRequestState } = await import('../src/flows/familyBookingPayment.js');
  const { notifyUser } = await import('../src/services/notify.js');
  const { User, Booking } = await import('../src/models/index.js');
  const { BOOKING_STATUS } = await import('../src/utils/constants.js');
  const M = await import('../src/utils/messages.js');

  const { booking } = await approveTransfer(payment, { note: 'verified in test' });
  if (!booking) return;

  const [family, nanny] = await Promise.all([
    User.findById(booking.family),
    booking.nanny ? User.findById(booking.nanny) : null,
  ]);
  if (family) await notifyUser(family, M.PAYMENT_VERIFIED);

  if (nanny && booking.status === BOOKING_STATUS.PENDING_PAYMENT) {
    const { expiresAt } = openNannyResponseWindow(booking, nanny._id, 'new_booking');
    booking.status = BOOKING_STATUS.UPCOMING;
    await booking.save();
    await notifyUser(nanny, M.nannyBookingRequest(booking, family, expiresAt));
    await setNannyRequestState(nanny, booking);
  }
}

test('a mail provider failure does not abandon registration', async () => {
  const { Otp } = await import('../src/models/index.js');
  const { issueOtp } = await import('../src/flows/common.js');

  // issueOtp must report delivery rather than throw: a provider outage used
  // to surface as "something went wrong" and drop people mid-signup.
  const result = await issueOtp('971500008888', 'someone@example.com');

  assert.ok(result.code, 'a code is always generated');
  assert.equal(typeof result.delivered, 'boolean', 'delivery is reported, not thrown');

  // Stored regardless, so a resend (or an admin) can still complete signup.
  const stored = await Otp.findOne({ phone: '971500008888' });
  assert.ok(stored, 'the code is saved even when the email fails');
  assert.equal(stored.code, result.code);
});

test('support menu offers technical problem, agent callback and FAQs', async () => {
  const { Ticket } = await import('../src/models/index.js');

  await createVerifiedNanny();
  await familyBookingUpToListing();          // registers the family
  await say(FAMILY, '0');

  let reply = await say(FAMILY, '6');        // Help / Support
  assert.match(reply, /Technical Problem/);
  assert.match(reply, /Talk to an Agent/);
  assert.match(reply, /FAQs/);

  // --- FAQs: topic -> question -> answer, then back out ---
  reply = await say(FAMILY, '6');
  assert.match(reply, /Frequently Asked Questions/);

  reply = await say(FAMILY, '1');            // Payments
  assert.match(reply, /Payment FAQ/);

  reply = await say(FAMILY, '1');            // first question
  assert.match(reply, /verified by our team/i, 'answers describe manual transfers');

  reply = await say(FAMILY, 'Back');
  assert.match(reply, /Help \/ Support/);

  // --- Technical problem files a ticket with the chosen label ---
  await say(FAMILY, '4');
  reply = await say(FAMILY, '1');            // "Bot is not responding"
  assert.match(reply, /describe the problem/i);

  reply = await say(FAMILY, 'The bot stopped replying this morning.');
  assert.match(reply, /support request has been submitted/i);
  assert.match(reply, /Support Ticket/);

  const technical = await Ticket.findOne({ category: 'technical_problem' });
  assert.ok(technical, 'technical ticket was created');
  assert.equal(technical.subject, 'Bot is not responding');

  // --- Talk to an agent is filed as a high-priority callback ---
  await say(FAMILY, '5');
  reply = await say(FAMILY, 'I want to discuss a partnership.');
  assert.match(reply, /agents are currently busy/i);

  const agent = await Ticket.findOne({ category: 'agent_callback' });
  assert.ok(agent, 'agent callback ticket was created');
  assert.equal(agent.priority, 'high', 'someone is waiting, so it jumps the queue');
});

test('a nanny can be saved to favourites after rating, and reused', async () => {
  const { User, Booking } = await import('../src/models/index.js');

  const nanny = await createVerifiedNanny();
  await familyBookingUpToListing();
  await say(FAMILY, '1'); await say(FAMILY, '1'); await say(FAMILY, '1');
  await payAndApprove();
  await say(NANNY, '1');                     // nanny accepts

  // Complete the booking so it can be rated.
  const booking = await Booking.findOne({});
  booking.status = 'completed';
  booking.serviceDays.forEach((d) => { d.status = 'completed'; });
  booking.markModified('serviceDays');
  await booking.save();

  await say(FAMILY, '0');
  await say(FAMILY, '2');                    // My Bookings
  await say(FAMILY, '3');                    // Completed
  await say(FAMILY, '1');                    // the booking

  // Find the "Rate" option rather than assuming its number.
  const detail = await say(FAMILY, '');
  const rateOption = /(\d+)\.\s*[^\n]*Rate/i.exec(detail);
  assert.ok(rateOption, `expected a Rate option, got:\n${detail}`);

  await say(FAMILY, rateOption[1]);
  await say(FAMILY, '5');                    // five stars
  let reply = await say(FAMILY, 'She was wonderful with Emma.');
  assert.match(reply, /favourite nannies/i, 'offers to save her');

  reply = await say(FAMILY, '1');            // Yes
  assert.match(reply, /Added to your Favourite Nannies/i);

  const family = await User.findOne({ phone: FAMILY, role: 'family' });
  assert.equal(family.favouriteNannies.length, 1);
  assert.equal(String(family.favouriteNannies[0]), String(nanny._id));

  // She now appears under My Profile > Favourite Nannies.
  await say(FAMILY, '0');
  await say(FAMILY, '3');                    // My Profile
  reply = await say(FAMILY, '4');            // Favourite Nannies
  assert.match(reply, /Favourite Nannies/);
  assert.match(reply, /Maria Grook/);
});

test('identity verification shows status, and emergency contacts can be managed', async () => {
  const { User } = await import('../src/models/index.js');

  await createVerifiedNanny();
  await familyBookingUpToListing();
  await say(FAMILY, '0');
  await say(FAMILY, '3');                    // My Profile

  let reply = await say(FAMILY, '5');        // Identity Verification
  assert.match(reply, /Identity Verification/);
  assert.match(reply, /Not verified|Pending review|Verified/);

  await say(FAMILY, 'Back');

  reply = await say(FAMILY, '6');            // Emergency Contacts
  assert.match(reply, /Emergency Contacts/);
  assert.match(reply, /None saved yet/i);

  await say(FAMILY, '1');                    // Add
  reply = await say(FAMILY, 'Lara Craft, Mother, +92 300 1234567');
  assert.match(reply, /Lara Craft has been added/i);

  const family = await User.findOne({ phone: FAMILY, role: 'family' });
  assert.equal(family.emergencyContacts.length, 1);
  assert.equal(family.emergencyContacts[0].name, 'Lara Craft');
  assert.equal(family.emergencyContacts[0].relation, 'Mother');
});

test('only the word "nanny" starts the bot', async () => {
  // Anything else gets a nudge rather than the menu, so a stray message
  // never drops someone into registration half-way.
  for (const text of ['hi', 'hello', 'Hi there', 'nannies', '1']) {
    const reply = await say(FAMILY, text);
    assert.match(reply, /send:\s*\*nanny\*/i, `"${text}" should only get the hint`);
  }

  // Phones capitalise the first letter, so casing must not matter.
  for (const text of ['nanny', 'Nanny', 'NANNY', 'nanny!', 'Hi nanny']) {
    await clearDb();
    const reply = await say(FAMILY, text);
    assert.match(reply, /Welcome to \*My Nanny\*/, `"${text}" should start the bot`);
    assert.match(reply, /I'm a Family/);
  }
});

test('family registration collects name, email and verifies OTP', async () => {
  const { User } = await import('../src/models/index.js');

  let reply = await say(FAMILY, 'nanny');
  assert.match(reply, /Welcome to \*My Nanny\*/);
  assert.match(reply, /I'm a Family/);

  reply = await say(FAMILY, '1');
  assert.match(reply, /Find a Nanny/);

  reply = await say(FAMILY, '1');
  assert.match(reply, /What's your full name/);

  reply = await say(FAMILY, 'Sarah Johnson');
  assert.match(reply, /Great Sarah/);
  assert.match(reply, /What's your email/);

  reply = await say(FAMILY, 'sarah@email.com');
  assert.match(reply, /verification code/);

  reply = await say(FAMILY, '000000');
  assert.match(reply, /doesn't match/, 'wrong OTP is rejected');

  const code = await latestOtp(FAMILY);
  reply = await say(FAMILY, code);
  assert.match(reply, /account has been verified/);
  assert.match(reply, /99% of our nannies are female/, 'continues into find-a-nanny');

  const user = await User.findOne({ phone: FAMILY });
  assert.equal(user.fullName, 'Sarah Johnson');
  assert.equal(user.emailVerified, true);
});

test('single-day booking flow reaches a correct summary', async () => {
  await createVerifiedNanny();
  const summary = await familyBookingUpToListing();

  assert.match(summary, /Booking Summary/);
  assert.match(summary, /9:00 AM – 11:00 AM/, 'renders the time range');
  assert.match(summary, /Downtown Dubai/);
  assert.match(summary, /Emma — 4 years/);
  assert.match(summary, /Peanut allergy/);
  assert.match(summary, /Vegetarian/);
  assert.match(summary, /Total Children:\* 1/);
  assert.match(summary, /Continue \(Start payment process\)/);
});

test('editing the booking updates the summary', async () => {
  await createVerifiedNanny();
  await familyBookingUpToListing();

  let reply = await say(FAMILY, '2');           // Edit Booking
  assert.match(reply, /What do you want to edit/);

  reply = await say(FAMILY, '2');               // Start Time
  assert.match(reply, /What time does the session start/);

  reply = await say(FAMILY, '11 AM');
  assert.match(reply, /edit anything else/);

  reply = await say(FAMILY, '2');               // No
  assert.match(reply, /Updated Booking Summary/);
  assert.match(reply, /11:00 AM – 1:00 PM/, 'new time is reflected');
});

test('nanny search lists matching nannies and shows a full profile', async () => {
  await createVerifiedNanny();
  await familyBookingUpToListing();

  let reply = await say(FAMILY, '1');           // Continue -> search
  assert.match(reply, /searching for a perfect nanny/);
  assert.match(reply, /available nannies/);
  assert.match(reply, /Maria Grook/);
  assert.match(reply, /\$25\/hr/);

  reply = await say(FAMILY, '1');               // view profile
  assert.match(reply, /Maria Grook/);
  assert.match(reply, /English ⭐4, Arabic ⭐5/);
  assert.match(reply, /✅CPR Certificate/);
  assert.match(reply, /Book this nanny/);
});

test('nannies are no longer filtered by budget or CPR', async () => {
  // The budget and CPR questions were removed, so an expensive nanny must
  // still be offered rather than silently filtered out.
  await createVerifiedNanny(NANNY, { rate: 200 });
  await familyBookingUpToListing();

  const reply = await say(FAMILY, '1');
  assert.match(reply, /available nannies/, 'search still returns results');
  assert.match(reply, /Maria Grook/);
  assert.match(reply, /\$200\/hr/, 'the rate is shown, not used as a filter');
});

test('booking asks for a date by option, and flags same-day as an emergency', async () => {
  const { Booking } = await import('../src/models/index.js');
  await createVerifiedNanny();

  await say(FAMILY, 'nanny');
  await say(FAMILY, '1');
  await say(FAMILY, '1');
  await say(FAMILY, 'Sarah Johnson');
  await say(FAMILY, 'sarah@email.com');
  await say(FAMILY, await latestOtp(FAMILY));
  await say(FAMILY, 'https://maps.google.com/?q=25.2,55.3');
  await say(FAMILY, 'Downtown Dubai');
  await say(FAMILY, '2');

  let reply = await say(FAMILY, '1');            // single day
  assert.match(reply, /1\. Today/, 'offers Today');
  assert.match(reply, /2\. Tomorrow/, 'offers Tomorrow');
  assert.match(reply, /3\. Another day/);

  reply = await say(FAMILY, '1');                // Today
  assert.match(reply, /Is this an emergency/i, 'same-day asks about urgency');

  reply = await say(FAMILY, '1');                // yes, urgent
  assert.match(reply, /emergency/i);

  // Straight into the time question — no budget or CPR steps any more.
  await say(FAMILY, '9 AM');
  await say(FAMILY, '2');
  await say(FAMILY, '1 2');
  await say(FAMILY, '1 3');
  await say(FAMILY, '1');
  await say(FAMILY, 'Emma');
  await say(FAMILY, '4 years');
  await say(FAMILY, 'None');
  await say(FAMILY, 'None');
  const summary = await say(FAMILY, 'None');

  assert.match(summary, /EMERGENCY BOOKING/, 'the summary marks it as urgent');
  assert.doesNotMatch(summary, /budget/i, 'no budget anywhere in the flow');

  // And it reaches the booking, so the dashboard can surface it.
  await say(FAMILY, '1'); await say(FAMILY, '1'); await say(FAMILY, '1');
  await payAndApprove();

  const booking = await Booking.findOne({});
  assert.equal(booking.isEmergency, true);
  assert.equal(booking.startDate, dayjs().format('YYYY-MM-DD'));
});

test('manual transfer: proof is queued, and admin approval releases the request', async () => {
  await createVerifiedNanny();
  const { Booking } = await import('../src/models/index.js');
  const { Payment } = await import('../src/models/Payment.js');

  await familyBookingUpToListing();
  await say(FAMILY, '1');           // search
  await say(FAMILY, '1');           // view Maria
  let reply = await say(FAMILY, '1');   // book this nanny
  assert.match(reply, /Pay First/);

  reply = await say(FAMILY, '1');   // start payment
  assert.match(reply, /front image of your id card/);

  await say(FAMILY, '', { mediaUrl: 'https://cdn/fam-id-front.jpg' });
  reply = await say(FAMILY, '', { mediaUrl: 'https://cdn/fam-id-back.jpg' });
  assert.match(reply, /Amount to transfer/, 'bank details are shown');
  assert.match(reply, /send a screenshot/i);

  // Typing instead of attaching is rejected, so proof is never skipped.
  reply = await say(FAMILY, 'I already paid');
  assert.match(reply, /attach the screenshot/i);

  reply = await say(FAMILY, '', { mediaUrl: 'https://cdn/receipt.jpg' });
  assert.match(reply, /received your payment proof/i);

  let booking = await Booking.findOne({});
  assert.ok(booking, 'booking was created');
  assert.equal(booking.status, 'pending_payment', 'held until an admin verifies');
  assert.equal(booking.paymentStatus, 'payment_in_process');
  assert.equal(booking.paidAmount, 0, 'nothing is counted as paid yet');
  assert.equal(booking.totalAmount, 50, '$25/hr x 2 hrs x 1 day');

  const payment = await Payment.findOne({ booking: booking._id });
  assert.equal(payment.proof.url, 'https://cdn/receipt.jpg', 'screenshot is stored');
  assert.equal(payment.method, 'bank_transfer');

  // The nanny must NOT be asked to hold a slot before the money is verified.
  assert.ok(
    !messagesTo(NANNY).some((m) => m.includes('New Booking Request')),
    'nanny is not notified until payment is approved',
  );

  await approvePaymentAsAdmin(payment);

  booking = await Booking.findById(booking._id);
  assert.equal(booking.status, 'upcoming');
  assert.equal(booking.subStatus, 'awaiting_nanny_confirmation');
  assert.equal(booking.paymentStatus, 'payment_completed');
  assert.equal(booking.paidAmount, 50);

  const request = messagesTo(NANNY).find((m) => m.includes('New Booking Request'));
  assert.ok(request, 'nanny received the booking request after approval');
  assert.match(request, /Accept Booking/);

  const pending = booking.nannyResponses.find((r) => r.outcome === 'pending');
  const windowMinutes = Math.round((pending.expiresAt - pending.sentAt) / 60000);
  assert.equal(windowMinutes, 60, 'new bookings give the nanny 1 hour');

  assert.ok(
    messagesTo(FAMILY).some((m) => /Payment verified/i.test(m)),
    'family was told the payment cleared',
  );
});

test('a rejected transfer leaves the booking unpaid and lets the family retry', async () => {
  await createVerifiedNanny();
  const { Booking } = await import('../src/models/index.js');
  const { Payment } = await import('../src/models/Payment.js');
  const { rejectTransfer } = await import('../src/services/payments.js');

  await familyBookingUpToListing();
  await say(FAMILY, '1'); await say(FAMILY, '1'); await say(FAMILY, '1');
  const booking = await payAndApprove(FAMILY, { approve: false });

  const payment = await Payment.findOne({ booking: booking._id });
  await rejectTransfer(payment, { note: 'Amount does not match' });

  const after = await Booking.findById(booking._id);
  assert.equal(after.paymentStatus, 'payment_failed');
  assert.equal(after.paidAmount, 0, 'nothing was credited');
  assert.ok(
    !messagesTo(NANNY).some((m) => m.includes('New Booking Request')),
    'a rejected payment never reaches the nanny',
  );
});

test('nanny accepting confirms the booking and notifies the family', async () => {
  await createVerifiedNanny();
  const { Booking } = await import('../src/models/index.js');

  await familyBookingUpToListing();
  await say(FAMILY, '1'); await say(FAMILY, '1'); await say(FAMILY, '1');
  await payAndApprove();

  const reply = await say(NANNY, '1');   // accept
  assert.match(reply, /Booking Accepted/);

  const booking = await Booking.findOne({});
  assert.equal(booking.subStatus, 'nanny_confirmed');

  const familyMsgs = messagesTo(FAMILY);
  assert.ok(familyMsgs.some((m) => /Booking Confirmed/.test(m)), 'family was told');
});

test('nanny declining moves the booking to replacement-needed', async () => {
  await createVerifiedNanny();
  const { Booking } = await import('../src/models/index.js');

  await familyBookingUpToListing();
  await say(FAMILY, '1'); await say(FAMILY, '1'); await say(FAMILY, '1');
  await payAndApprove();

  await say(NANNY, '2');              // decline
  const reply = await say(NANNY, 'Not available');
  assert.match(reply, /declined/i);

  const booking = await Booking.findOne({});
  assert.equal(booking.nanny, undefined, 'nanny is unassigned');
  assert.equal(booking.subStatus, 'nanny_cancelled_awaiting_replacement');
  assert.equal(booking.rejectedNannies.length, 1, 'declining nanny is excluded from re-matching');

  const familyMsgs = messagesTo(FAMILY);
  assert.ok(familyMsgs.some((m) => /unavailable/i.test(m)), 'family was notified');
});

test('multi-day booking builds one service day per matching weekday', async () => {
  await createVerifiedNanny();
  const { Booking } = await import('../src/models/index.js');

  // Pick a Monday so the repeat days are predictable.
  let start = dayjs().add(7, 'day');
  while (start.day() !== 1) start = start.add(1, 'day');
  const end = start.add(13, 'day');   // two full weeks

  await say(FAMILY, 'nanny');
  await say(FAMILY, '1');
  await say(FAMILY, '1');
  await say(FAMILY, 'Sarah Johnson');
  await say(FAMILY, 'sarah@email.com');
  await say(FAMILY, await latestOtp(FAMILY));
  await say(FAMILY, 'None');                       // no map link
  await say(FAMILY, 'Downtown Dubai');
  await say(FAMILY, '2');
  await say(FAMILY, '2');                          // multiple days
  await say(FAMILY, start.format('YYYY-MM-DD'));
  await say(FAMILY, end.format('YYYY-MM-DD'));
  await say(FAMILY, '1 2 3');                      // Mon, Tue, Wed (spaces)
  await say(FAMILY, '9 AM');
  await say(FAMILY, '2');
  await say(FAMILY, '1 2');
  await say(FAMILY, '1 3');
  await say(FAMILY, '1');
  await say(FAMILY, 'Emma');
  await say(FAMILY, '4 years');
  await say(FAMILY, 'None');
  await say(FAMILY, 'None');
  const summary = await say(FAMILY, 'None');

  assert.match(summary, /Repeat on Monday, Tuesday & Wednesday/);
  assert.match(summary, /6 days/, 'two weeks x 3 days = 6 service days');

  await say(FAMILY, '1'); await say(FAMILY, '1'); await say(FAMILY, '1');
  await payAndApprove();

  const booking = await Booking.findOne({});
  assert.equal(booking.serviceDays.length, 6);
  assert.equal(booking.isMultiDay, true);
  assert.equal(booking.totalAmount, 25 * 2 * 6, 'rate x hours x days');
});

test('global commands work: 0 returns to the main menu', async () => {
  await say(FAMILY, 'nanny');
  await say(FAMILY, '1');
  await say(FAMILY, '1');
  await say(FAMILY, 'Sarah Johnson');

  const reply = await say(FAMILY, '0');
  assert.match(reply, /Find a Nanny/);
  assert.match(reply, /My Bookings/);
});

test('family and nanny chat relays messages without exposing numbers', async () => {
  await createVerifiedNanny();
  await familyBookingUpToListing();
  await say(FAMILY, '1');           // search
  await say(FAMILY, '1');           // profile

  let reply = await say(FAMILY, '2');   // chat with nanny
  assert.match(reply, /You can now chat with Maria Grook/);
  assert.match(reply, /phone numbers remain private/);

  await say(FAMILY, 'Do you have newborn experience?');
  const nannyMsgs = messagesTo(NANNY);
  const relayed = nannyMsgs.find((m) => m.includes('newborn experience'));
  assert.ok(relayed, 'message reached the nanny');
  assert.ok(!relayed.includes(FAMILY), 'family phone number is not leaked');

  reply = await say(FAMILY, 'BYE');
  assert.match(reply, /Book this nanny/);
});

test('OTP arrival and end-of-service confirmation complete a booking', async () => {
  await createVerifiedNanny();
  const { Booking } = await import('../src/models/index.js');
  const { processServiceDayTransitions } = await import('../src/jobs/scheduler.js');

  // Book for today so the service can start during the test.
  const today = dayjs().format('YYYY-MM-DD');
  await familyBookingUpToListing(FAMILY, { date: today });
  await say(FAMILY, '1'); await say(FAMILY, '1'); await say(FAMILY, '1');
  await payAndApprove();
  await say(NANNY, '1');            // accept

  let booking = await Booking.findOne({});
  const day = booking.serviceDays[0];

  // Force the service to have started, then run the transition job.
  day.startAt = new Date(Date.now() - 60000);
  day.endAt = new Date(Date.now() + 3600e3);
  booking.markModified('serviceDays');
  await booking.save();
  await processServiceDayTransitions(new Date());

  booking = await Booking.findOne({});
  assert.equal(booking.serviceDays[0].status, 'awaiting_arrival');
  assert.equal(booking.status, 'ongoing');

  const arrivalCode = booking.serviceDays[0].arrivalOtp;
  assert.ok(messagesTo(FAMILY).some((m) => m.includes(arrivalCode)), 'family got the arrival code');

  // Nanny enters the arrival code.
  await say(NANNY, '2');            // My Bookings
  await say(NANNY, '2');            // Ongoing
  await say(NANNY, '1');            // the booking
  await say(NANNY, '1');            // Confirm My Arrival
  let reply = await say(NANNY, 'WRONG');
  assert.match(reply, /incorrect|doesn't look right/i);

  reply = await say(NANNY, arrivalCode);
  assert.match(reply, /arrival has been confirmed/i);

  booking = await Booking.findOne({});
  assert.equal(booking.serviceDays[0].status, 'arrival_confirmed');

  // End the service window and run the job again.
  booking.serviceDays[0].endAt = new Date(Date.now() - 1000);
  booking.markModified('serviceDays');
  await booking.save();
  await processServiceDayTransitions(new Date());

  booking = await Booking.findOne({});
  assert.equal(booking.serviceDays[0].status, 'awaiting_end_of_service');
  const endCode = booking.serviceDays[0].endOtp;

  await say(NANNY, '0');            // back to main menu
  await say(NANNY, '2'); await say(NANNY, '2'); await say(NANNY, '1');
  await say(NANNY, '1');            // Confirm End of Service
  reply = await say(NANNY, endCode);
  assert.match(reply, /Service Completed/);

  booking = await Booking.findOne({});
  assert.equal(booking.status, 'completed');
  assert.equal(booking.serviceDays[0].status, 'completed');

  // A payout was queued for the completed day.
  const { Payout } = await import('../src/models/Payment.js');
  const payout = await Payout.findOne({ booking: booking._id });
  assert.ok(payout, 'payout queued');
  assert.equal(payout.amount, 50);
  assert.equal(payout.isFinalForBooking, true);
});

test('family cancellation applies the policy and refunds correctly', async () => {
  await createVerifiedNanny();
  const { Booking } = await import('../src/models/index.js');
  const { Payment } = await import('../src/models/Payment.js');

  // 10 days out => 100% refund for a single-day booking.
  await familyBookingUpToListing();
  await say(FAMILY, '1'); await say(FAMILY, '1'); await say(FAMILY, '1');
  await payAndApprove();
  await say(NANNY, '1');

  await say(FAMILY, '0');
  await say(FAMILY, '2');           // My Bookings
  await say(FAMILY, '1');           // Upcoming
  let reply = await say(FAMILY, '1');
  assert.match(reply, /Booking ID#/);
  assert.match(reply, /Cancel Booking/);

  // "Cancel Booking" is option 7 on the upcoming menu.
  reply = await say(FAMILY, '7');
  assert.match(reply, /Refund you will receive: \*\$50/);

  reply = await say(FAMILY, '1');   // confirm
  assert.match(reply, /Booking Cancelled/);
  assert.match(reply, /Refund: \*\$50/);

  const booking = await Booking.findOne({});
  assert.equal(booking.status, 'cancelled');
  assert.equal(booking.refundDue, 50, 'policy says $50 is owed');
  assert.equal(booking.refundedAmount, 0, 'not credited until an admin sends it');
  assert.equal(booking.paymentStatus, 'refund_in_process');

  const refund = await Payment.findOne({ kind: 'refund' });
  assert.ok(refund, 'refund payment recorded');
  assert.equal(refund.amount, 50);
  assert.equal(refund.status, 'refund_in_process');

  // The admin transfers the money and attaches the receipt.
  const { completeRefund } = await import('../src/services/payments.js');
  await completeRefund(refund, { proof: { url: 'https://cdn/refund.jpg' } });

  const settled = await Booking.findById(booking._id);
  assert.equal(settled.refundedAmount, 50, 'credited once actually sent');
  assert.equal(settled.paymentStatus, 'refunded');
});

test('response timeout unassigns the nanny and offers replacements', async () => {
  await createVerifiedNanny(NANNY, { name: 'Maria Grook' });
  await createVerifiedNanny('971500000003', { name: 'Anna Smith', rate: 30 });

  const { Booking } = await import('../src/models/index.js');
  const { processResponseTimeouts } = await import('../src/jobs/scheduler.js');

  await familyBookingUpToListing();
  await say(FAMILY, '1'); await say(FAMILY, '1'); await say(FAMILY, '1');
  await payAndApprove();

  // Expire the window without a response.
  let booking = await Booking.findOne({});
  const pending = booking.nannyResponses.find((r) => r.outcome === 'pending');
  pending.expiresAt = new Date(Date.now() - 1000);
  await booking.save();

  const handled = await processResponseTimeouts(new Date());
  assert.equal(handled.length, 1);

  booking = await Booking.findOne({});
  assert.equal(booking.nanny, undefined);
  assert.equal(booking.subStatus, 'nanny_cancelled_awaiting_replacement');

  const familyMsgs = messagesTo(FAMILY);
  assert.ok(familyMsgs.some((m) => /unavailable/i.test(m)), 'family told the nanny is unavailable');
});

test('nanny cancelling an accepted booking triggers replacement, not cancellation', async () => {
  await createVerifiedNanny();
  await createVerifiedNanny('971500000003', { name: 'Anna Smith', rate: 25 });
  const { Booking } = await import('../src/models/index.js');

  await familyBookingUpToListing();
  await say(FAMILY, '1'); await say(FAMILY, '1'); await say(FAMILY, '1');
  await payAndApprove();
  await say(NANNY, '1');            // accept

  // Nanny requests cancellation.
  await say(NANNY, '0');
  await say(NANNY, '2');            // My Bookings
  await say(NANNY, '1');            // Upcoming
  await say(NANNY, '1');            // the booking
  let reply = await say(NANNY, '4');   // Request Cancellation
  assert.match(reply, /Request Cancellation/);

  reply = await say(NANNY, 'Family emergency');
  assert.match(reply, /Are you sure/);

  reply = await say(NANNY, '1');
  assert.match(reply, /cancellation has been recorded/i);

  const booking = await Booking.findOne({});
  assert.notEqual(booking.status, 'cancelled', 'booking is NOT cancelled');
  assert.equal(booking.subStatus, 'nanny_cancelled_awaiting_replacement');
  assert.equal(booking.nanny, undefined);

  const familyMsgs = messagesTo(FAMILY);
  assert.ok(familyMsgs.some((m) => /nanny has cancelled/i.test(m)));
  assert.ok(familyMsgs.some((m) => /Anna Smith/.test(m)), 'replacement offered');
});

test('nanny availability blocking prevents matching on that date', async () => {
  const nanny = await createVerifiedNanny();
  const target = dayjs().add(10, 'day').format('YYYY-MM-DD');

  nanny.availability.blockedDates = [target];
  nanny.markModified('availability');
  await nanny.save();

  await familyBookingUpToListing(FAMILY, { date: target });
  const reply = await say(FAMILY, '1');
  assert.match(reply, /we will call you/i, 'blocked date removes her from results');

  // An unmatched search must leave a callback for the team to follow up.
  const { CallbackRequest } = await import('../src/models/index.js');
  const cb = await CallbackRequest.findOne({ phone: FAMILY });
  assert.ok(cb, 'a callback request was recorded');
  assert.equal(cb.reason, 'no_nanny_found');
  assert.equal(cb.status, 'pending');
  assert.equal(cb.request.startDate, target, 'the requested date is captured');
  assert.deepEqual(cb.request.children.map((c) => c.name), ['Emma'], 'children are captured');
  assert.ok(cb.request.skills.length, 'skills are captured');
});
