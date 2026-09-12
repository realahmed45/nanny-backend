import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, clearDb, outbox } from './helpers.js';

/**
 * The API behind the phone app.
 *
 * Driven over a real HTTP port rather than by calling handlers directly: the
 * things most likely to break here are the middleware — the token check, the
 * body size limit, the JSON parsing — and none of those run if the route
 * function is called on its own.
 */

let server;
let base;

before(async () => {
  await setupDb();
  const { createApp } = await import('../src/index.js');
  const app = createApp();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/nanny`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await teardownDb();
});

beforeEach(async () => { await clearDb(); });

/** One request, returning status and parsed body together. */
async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/** A verified nanny and a token for her. */
async function makeNanny(phone = '999100000001', extra = {}) {
  const { User } = await import('../src/models/index.js');
  const { USER_ROLE, NANNY_STATUS } = await import('../src/utils/constants.js');
  const { signNannyToken } = await import('../src/middleware/nannyAuth.js');

  const nanny = await User.create({
    role: USER_ROLE.NANNY,
    phone,
    fullName: 'Test Nanny',
    nickname: 'Tessa',
    nannyStatus: NANNY_STATUS.VERIFIED,
    age: 30,
    ...extra,
  });

  return { nanny, token: signNannyToken(nanny) };
}

/* ------------------------------------------------------------------ *
 * Who can get in
 * ------------------------------------------------------------------ */

test('no token gets nothing', async () => {
  const res = await call('/me');
  assert.equal(res.status, 401);
});

test('a nanny reads her own profile', async () => {
  const { token } = await makeNanny();
  const res = await call('/me', { token });
  assert.equal(res.status, 200);
  assert.equal(res.data.nanny.nickname, 'Tessa');
});

test('a blocked nanny is turned away even holding a valid token', async () => {
  const { nanny, token } = await makeNanny();
  const { NANNY_STATUS } = await import('../src/utils/constants.js');

  // The token was signed while she was in good standing; the check has to
  // re-read her account rather than trust what the token said at the time.
  nanny.nannyStatus = NANNY_STATUS.SUSPENDED;
  await nanny.save();

  const res = await call('/me', { token });
  assert.equal(res.status, 403);
});

/* ------------------------------------------------------------------ *
 * Days off
 * ------------------------------------------------------------------ */

test('she can block and unblock a free day', async () => {
  const { token } = await makeNanny();

  const blocked = await call('/availability/dates', {
    method: 'PATCH', token, body: { block: ['2030-01-15'] },
  });
  assert.equal(blocked.status, 200);
  assert.deepEqual(blocked.data.blockedDates, ['2030-01-15']);

  const freed = await call('/availability/dates', {
    method: 'PATCH', token, body: { unblock: ['2030-01-15'] },
  });
  assert.equal(freed.status, 200);
  assert.deepEqual(freed.data.blockedDates, []);
});

test('blocking a day she is booked on is refused, and says to cancel first', async () => {
  const { nanny, token } = await makeNanny();
  const { Booking, User } = await import('../src/models/index.js');
  const { BOOKING_STATUS, USER_ROLE, SERVICE_DAY_STATUS } = await import('../src/utils/constants.js');

  const family = await User.create({
    role: USER_ROLE.FAMILY, phone: '999200000001', fullName: 'A Family',
  });

  await Booking.create({
    bookingNumber: 'B-TEST-1',
    family: family._id,
    nanny: nanny._id,
    status: BOOKING_STATUS.UPCOMING,
    startDate: '2030-02-10',
    endDate: '2030-02-10',
    serviceDays: [{
      date: '2030-02-10',
      startAt: new Date('2030-02-10T09:00:00Z'),
      endAt: new Date('2030-02-10T17:00:00Z'),
      hours: 8,
      status: SERVICE_DAY_STATUS.SCHEDULED,
    }],
  });

  const res = await call('/availability/dates', {
    method: 'PATCH', token, body: { block: ['2030-02-10'] },
  });

  assert.equal(res.status, 409);
  assert.deepEqual(res.data.dates, ['2030-02-10']);
  // The way out has to be in the message: she cannot act on "no" alone.
  assert.match(res.data.detail, /cancel the booking first/i);
});

/* ------------------------------------------------------------------ *
 * Live location
 * ------------------------------------------------------------------ */

test('a position is stored on her record', async () => {
  const { nanny, token } = await makeNanny();
  const { User } = await import('../src/models/index.js');

  const res = await call('/location', {
    method: 'POST', token, body: { lat: -8.65, lng: 115.13, accuracy: 12 },
  });
  assert.equal(res.status, 200);

  const fresh = await User.findById(nanny._id).lean();
  assert.equal(Math.round(fresh.lastLocation.lat * 100), -865);
  assert.ok(fresh.lastLocation.at);
});

test('nonsense coordinates are refused', async () => {
  const { token } = await makeNanny();
  const res = await call('/location', {
    method: 'POST', token, body: { lat: 999, lng: 0 },
  });
  assert.equal(res.status, 400);
});

test('a family sees her position only while their booking is running', async () => {
  const { nanny, token } = await makeNanny();
  const { Booking, User } = await import('../src/models/index.js');
  const { BOOKING_STATUS, USER_ROLE, SERVICE_DAY_STATUS } = await import('../src/utils/constants.js');

  const family = await User.create({
    role: USER_ROLE.FAMILY, phone: '999200000002', fullName: 'B Family',
  });

  const now = Date.now();
  const make = (startOffsetMs, endOffsetMs) => Booking.create({
    bookingNumber: `B-${startOffsetMs}`,
    family: family._id,
    nanny: nanny._id,
    status: BOOKING_STATUS.UPCOMING,
    startDate: '2030-03-01',
    endDate: '2030-03-01',
    liveLocation: { nannySharing: true },
    serviceDays: [{
      date: '2030-03-01',
      startAt: new Date(now + startOffsetMs),
      endAt: new Date(now + endOffsetMs),
      hours: 4,
      status: SERVICE_DAY_STATUS.SCHEDULED,
    }],
  });

  const running = await make(-3600_000, 3600_000);     // started an hour ago
  const finished = await make(-6 * 3600_000, -2 * 3600_000);  // ended 2h ago
  const future = await make(48 * 3600_000, 52 * 3600_000);    // in two days

  const res = await call('/location', {
    method: 'POST', token, body: { lat: -8.65, lng: 115.13 },
  });
  assert.equal(res.status, 200);

  const shared = res.data.sharedWithBookings.map(String);
  assert.deepEqual(shared, [String(running._id)]);

  // The one that ended two hours ago is well past the 45 minute tail.
  const done = await Booking.findById(finished._id).lean();
  assert.equal(done.liveLocation.lastNannyLocation, undefined);

  const later = await Booking.findById(future._id).lean();
  assert.equal(later.liveLocation.lastNannyLocation, undefined);
});

test('sharing stays on through the 45 minutes after a booking ends', async () => {
  const { nanny, token } = await makeNanny();
  const { Booking, User } = await import('../src/models/index.js');
  const { BOOKING_STATUS, USER_ROLE, SERVICE_DAY_STATUS } = await import('../src/utils/constants.js');

  const family = await User.create({
    role: USER_ROLE.FAMILY, phone: '999200000003', fullName: 'C Family',
  });

  // Ended twenty minutes ago: she is still getting home, and that is exactly
  // the window the tail exists for.
  const booking = await Booking.create({
    bookingNumber: 'B-TAIL',
    family: family._id,
    nanny: nanny._id,
    status: BOOKING_STATUS.ONGOING,
    startDate: '2030-03-02',
    endDate: '2030-03-02',
    liveLocation: { nannySharing: true },
    serviceDays: [{
      date: '2030-03-02',
      startAt: new Date(Date.now() - 5 * 3600_000),
      endAt: new Date(Date.now() - 20 * 60_000),
      hours: 5,
      status: SERVICE_DAY_STATUS.SCHEDULED,
    }],
  });

  const res = await call('/location', {
    method: 'POST', token, body: { lat: -8.7, lng: 115.2 },
  });

  assert.deepEqual(res.data.sharedWithBookings.map(String), [String(booking._id)]);
});

test('a position is not shared when she has sharing switched off', async () => {
  const { nanny, token } = await makeNanny();
  const { Booking, User } = await import('../src/models/index.js');
  const { BOOKING_STATUS, USER_ROLE, SERVICE_DAY_STATUS } = await import('../src/utils/constants.js');

  const family = await User.create({
    role: USER_ROLE.FAMILY, phone: '999200000004', fullName: 'D Family',
  });

  await Booking.create({
    bookingNumber: 'B-OFF',
    family: family._id,
    nanny: nanny._id,
    status: BOOKING_STATUS.ONGOING,
    startDate: '2030-03-03',
    endDate: '2030-03-03',
    liveLocation: { nannySharing: false },
    serviceDays: [{
      date: '2030-03-03',
      startAt: new Date(Date.now() - 3600_000),
      endAt: new Date(Date.now() + 3600_000),
      hours: 2,
      status: SERVICE_DAY_STATUS.SCHEDULED,
    }],
  });

  const res = await call('/location', {
    method: 'POST', token, body: { lat: -8.7, lng: 115.2 },
  });
  assert.deepEqual(res.data.sharedWithBookings, []);
});

test('she cannot switch on sharing for a booking that is not hers', async () => {
  const { token } = await makeNanny('999100000010');
  const { nanny: other } = await makeNanny('999100000011');
  const { Booking, User } = await import('../src/models/index.js');
  const { BOOKING_STATUS, USER_ROLE } = await import('../src/utils/constants.js');

  const family = await User.create({
    role: USER_ROLE.FAMILY, phone: '999200000005', fullName: 'E Family',
  });

  const theirs = await Booking.create({
    bookingNumber: 'B-OTHER',
    family: family._id,
    nanny: other._id,
    status: BOOKING_STATUS.UPCOMING,
    startDate: '2030-04-01',
    endDate: '2030-04-01',
  });

  const res = await call(`/bookings/${theirs._id}/location-sharing`, {
    method: 'PATCH', token, body: { sharing: true },
  });
  assert.equal(res.status, 404);
});

/* ------------------------------------------------------------------ *
 * Her profile
 * ------------------------------------------------------------------ */

test('she can edit her own details', async () => {
  const { token } = await makeNanny();
  const res = await call('/me', {
    method: 'PATCH', token,
    body: { nickname: 'Tess', age: 31, cprCertified: true },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.nanny.nickname, 'Tess');
  assert.equal(res.data.nanny.age, 31);
  assert.equal(res.data.nanny.cprCertified, true);
});

test('she cannot verify herself', async () => {
  const { token } = await makeNanny('999100000020', { nannyStatus: 'pending_verification' });
  await call('/me', {
    method: 'PATCH', token,
    body: { nannyStatus: 'verified', verified: true, ratingAverage: 5 },
  });

  const after = await call('/me', { token });
  assert.notEqual(after.data.nanny.status, 'verified');
  assert.equal(after.data.nanny.ratingAverage, 0);
});

test('a nonsense age is refused', async () => {
  const { token } = await makeNanny();
  const res = await call('/me', { method: 'PATCH', token, body: { age: 4 } });
  assert.equal(res.status, 400);
});

/* ------------------------------------------------------------------ *
 * Media she sends from the app
 * ------------------------------------------------------------------ */

/** A one-pixel PNG, as base64 — small, valid, and not a real photo. */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'
  + 'YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('a photo she uploads arrives unapproved', async () => {
  const { nanny, token } = await makeNanny();

  const res = await call('/media', {
    method: 'POST', token,
    body: { kind: 'photo', ext: '.png', data: TINY_PNG },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.status, 'pending');

  const { User } = await import('../src/models/index.js');
  const fresh = await User.findById(nanny._id).lean();
  assert.equal(fresh.photos.length, 1);
  // The gate is the whole point: nothing reaches a family unreviewed.
  assert.equal(fresh.photos[0].approved, false);
  assert.equal(fresh.photos[0].featured, false);
});

test('the same picture sent twice is refused rather than duplicated', async () => {
  const { token } = await makeNanny();
  const body = { kind: 'photo', ext: '.png', data: TINY_PNG };

  assert.equal((await call('/media', { method: 'POST', token, body })).status, 201);
  assert.equal((await call('/media', { method: 'POST', token, body })).status, 409);
});

test('a file type that does not belong is refused', async () => {
  const { token } = await makeNanny();

  // An mp4 offered as a profile picture.
  const res = await call('/media', {
    method: 'POST', token,
    body: { kind: 'profile', ext: '.mp4', data: TINY_PNG },
  });
  assert.equal(res.status, 400);
});

test('an ID photo replaces the previous one instead of stacking', async () => {
  const { nanny, token } = await makeNanny();
  const { User } = await import('../src/models/index.js');

  await call('/media', {
    method: 'POST', token, body: { kind: 'id_front', ext: '.png', data: TINY_PNG },
  });
  // A different image, so it does not collide on content hash.
  await call('/media', {
    method: 'POST', token,
    body: { kind: 'id_front', ext: '.png', data: TINY_PNG.replace('YPhfDwAChwGA', 'YPhfDwAChwGB') },
  });

  const fresh = await User.findById(nanny._id).lean();
  assert.equal(fresh.documents.filter((d) => d.type === 'id_front').length, 1);
});

test('she can withdraw something still waiting, but not something approved', async () => {
  const { nanny, token } = await makeNanny();
  const { User } = await import('../src/models/index.js');

  await call('/media', {
    method: 'POST', token, body: { kind: 'photo', ext: '.png', data: TINY_PNG },
  });

  let fresh = await User.findById(nanny._id);
  const id = fresh.photos[0]._id;

  const gone = await call(`/media/photos/${id}`, { method: 'DELETE', token });
  assert.equal(gone.status, 200);

  // Now one that has been approved.
  await call('/media', {
    method: 'POST', token,
    body: { kind: 'photo', ext: '.png', data: TINY_PNG.replace('YPhfDwAChwGA', 'YPhfDwAChwGC') },
  });
  fresh = await User.findById(nanny._id);
  fresh.photos[0].approved = true;
  await fresh.save();

  const refused = await call(`/media/photos/${fresh.photos[0]._id}`, { method: 'DELETE', token });
  assert.equal(refused.status, 409);
});

/* ------------------------------------------------------------------ *
 * Signing in
 * ------------------------------------------------------------------ */

test('a sign-in code is sent, and the same answer comes back for an unknown number', async () => {
  await makeNanny('999100000030');

  const known = await call('/auth/request-code', {
    method: 'POST', body: { phone: '999100000030' },
  });
  const unknown = await call('/auth/request-code', {
    method: 'POST', body: { phone: '999100000099' },
  });

  // Identical replies: anything else turns this into a way to find out which
  // numbers are registered with us.
  assert.equal(known.status, unknown.status);
  assert.deepEqual(known.data, unknown.data);
});

test('a wrong code does not sign her in', async () => {
  await makeNanny('999100000031');
  await call('/auth/request-code', { method: 'POST', body: { phone: '999100000031' } });

  const res = await call('/auth/verify', {
    method: 'POST', body: { phone: '999100000031', code: '000000' },
  });
  assert.notEqual(res.status, 200);
  assert.equal(res.data.token, undefined);
});

test('the right code signs her in', async () => {
  await makeNanny('999100000032');
  await call('/auth/request-code', { method: 'POST', body: { phone: '999100000032' } });

  const { Otp } = await import('../src/models/index.js');
  const otp = await Otp.findOne({ phone: '999100000032', consumed: false }).sort({ createdAt: -1 });

  const res = await call('/auth/verify', {
    method: 'POST', body: { phone: '999100000032', code: otp.code },
  });
  assert.equal(res.status, 200);
  assert.ok(res.data.token);
  assert.equal(res.data.nanny.phone, '999100000032');
});

test('the seeded test numbers never reach the WhatsApp provider', async () => {
  await makeNanny('999100000040');
  outbox.length = 0;

  await call('/auth/request-code', { method: 'POST', body: { phone: '999100000040' } });

  // It is recorded as blocked rather than sent: a seeded number belongs to
  // nobody, and a bot messaging it is a bill at best.
  const sent = outbox.filter((m) => m.to === '999100000040');
  assert.ok(sent.every((m) => m.blocked));
});
