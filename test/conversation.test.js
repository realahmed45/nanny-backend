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

  await say(phone, 'Hi');
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

  await say(phone, 'Hi');
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
  await say(phone, '9 AM');
  await say(phone, '2');            // two hours
  await say(phone, '1,2');          // English, Arabic
  await say(phone, '1,3');          // Cooking, Newborn Care
  await say(phone, '$20');          // budget min
  await say(phone, '$50');          // budget max
  await say(phone, '1');            // CPR required
  await say(phone, '1');            // one child
  await say(phone, 'Emma');
  await say(phone, '4 years');
  await say(phone, 'Peanut allergy');
  await say(phone, 'Vegetarian');
  return say(phone, 'None');        // other instructions -> summary
}

test('family registration collects name, email and verifies OTP', async () => {
  const { User } = await import('../src/models/index.js');

  let reply = await say(FAMILY, 'Hello');
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

test('a nanny outside the budget is not matched', async () => {
  await createVerifiedNanny(NANNY, { rate: 200 });   // above the $50 max
  await familyBookingUpToListing();

  const reply = await say(FAMILY, '1');
  assert.match(reply, /couldn't find a nanny/i);
});

test('payment creates the booking and notifies the nanny with a 1-hour window', async () => {
  const nanny = await createVerifiedNanny();
  const { Booking } = await import('../src/models/index.js');

  await familyBookingUpToListing();
  await say(FAMILY, '1');           // search
  await say(FAMILY, '1');           // view Maria
  let reply = await say(FAMILY, '1');   // book this nanny
  assert.match(reply, /Pay First/);

  reply = await say(FAMILY, '1');   // start payment
  assert.match(reply, /front image of your id card/);

  await say(FAMILY, '', { mediaUrl: 'https://cdn/fam-id-front.jpg' });
  reply = await say(FAMILY, '', { mediaUrl: 'https://cdn/fam-id-back.jpg' });
  assert.match(reply, /Choose payment/);

  reply = await say(FAMILY, '1');   // credit card
  assert.match(reply, /Payment successful/);
  assert.match(reply, /Waiting for nanny confirmation/);
  assert.match(reply, /Booking ID#/);
  assert.match(reply, /PAID/);

  const booking = await Booking.findOne({});
  assert.ok(booking, 'booking was created');
  assert.equal(booking.status, 'upcoming');
  assert.equal(booking.subStatus, 'awaiting_nanny_confirmation');
  assert.equal(booking.totalAmount, 50, '$25/hr x 2 hrs x 1 day');
  assert.equal(booking.paidAmount, 50);

  // The nanny got the request, with a 1-hour clock.
  const nannyMessages = messagesTo(NANNY);
  const request = nannyMessages.find((m) => m.includes('New Booking Request'));
  assert.ok(request, 'nanny received the booking request');
  assert.match(request, /Accept Booking/);

  const pending = booking.nannyResponses.find((r) => r.outcome === 'pending');
  assert.ok(pending);
  const windowMinutes = Math.round((pending.expiresAt - pending.sentAt) / 60000);
  assert.equal(windowMinutes, 60, 'new bookings give the nanny 1 hour');
});

test('nanny accepting confirms the booking and notifies the family', async () => {
  await createVerifiedNanny();
  const { Booking } = await import('../src/models/index.js');

  await familyBookingUpToListing();
  await say(FAMILY, '1'); await say(FAMILY, '1'); await say(FAMILY, '1');
  await say(FAMILY, '1');
  await say(FAMILY, '', { mediaUrl: 'https://cdn/a.jpg' });
  await say(FAMILY, '', { mediaUrl: 'https://cdn/b.jpg' });
  await say(FAMILY, '1');

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
  await say(FAMILY, '1');
  await say(FAMILY, '', { mediaUrl: 'https://cdn/a.jpg' });
  await say(FAMILY, '', { mediaUrl: 'https://cdn/b.jpg' });
  await say(FAMILY, '1');

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

  await say(FAMILY, 'Hi');
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
  await say(FAMILY, '1,2,3');                      // Mon, Tue, Wed
  await say(FAMILY, '9 AM');
  await say(FAMILY, '2');
  await say(FAMILY, '1,2');
  await say(FAMILY, '1,3');
  await say(FAMILY, '$20');
  await say(FAMILY, '$50');
  await say(FAMILY, '3');                          // CPR either
  await say(FAMILY, '1');
  await say(FAMILY, 'Emma');
  await say(FAMILY, '4 years');
  await say(FAMILY, 'None');
  await say(FAMILY, 'None');
  const summary = await say(FAMILY, 'None');

  assert.match(summary, /Repeat on Monday, Tuesday & Wednesday/);
  assert.match(summary, /6 days/, 'two weeks x 3 days = 6 service days');

  await say(FAMILY, '1'); await say(FAMILY, '1'); await say(FAMILY, '1');
  await say(FAMILY, '1');
  await say(FAMILY, '', { mediaUrl: 'https://cdn/a.jpg' });
  await say(FAMILY, '', { mediaUrl: 'https://cdn/b.jpg' });
  await say(FAMILY, '1');

  const booking = await Booking.findOne({});
  assert.equal(booking.serviceDays.length, 6);
  assert.equal(booking.isMultiDay, true);
  assert.equal(booking.totalAmount, 25 * 2 * 6, 'rate x hours x days');
});

test('global commands work: 0 returns to the main menu', async () => {
  await say(FAMILY, 'Hi');
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
  await say(FAMILY, '1');
  await say(FAMILY, '', { mediaUrl: 'https://cdn/a.jpg' });
  await say(FAMILY, '', { mediaUrl: 'https://cdn/b.jpg' });
  await say(FAMILY, '1');
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
  await say(FAMILY, '1');
  await say(FAMILY, '', { mediaUrl: 'https://cdn/a.jpg' });
  await say(FAMILY, '', { mediaUrl: 'https://cdn/b.jpg' });
  await say(FAMILY, '1');
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
  assert.equal(booking.refundedAmount, 50);

  const refund = await Payment.findOne({ kind: 'refund' });
  assert.ok(refund, 'refund payment recorded');
  assert.equal(refund.amount, 50);
});

test('response timeout unassigns the nanny and offers replacements', async () => {
  await createVerifiedNanny(NANNY, { name: 'Maria Grook' });
  await createVerifiedNanny('971500000003', { name: 'Anna Smith', rate: 30 });

  const { Booking } = await import('../src/models/index.js');
  const { processResponseTimeouts } = await import('../src/jobs/scheduler.js');

  await familyBookingUpToListing();
  await say(FAMILY, '1'); await say(FAMILY, '1'); await say(FAMILY, '1');
  await say(FAMILY, '1');
  await say(FAMILY, '', { mediaUrl: 'https://cdn/a.jpg' });
  await say(FAMILY, '', { mediaUrl: 'https://cdn/b.jpg' });
  await say(FAMILY, '1');

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
  await say(FAMILY, '1');
  await say(FAMILY, '', { mediaUrl: 'https://cdn/a.jpg' });
  await say(FAMILY, '', { mediaUrl: 'https://cdn/b.jpg' });
  await say(FAMILY, '1');
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
  assert.match(reply, /couldn't find a nanny/i, 'blocked date removes her from results');
});
