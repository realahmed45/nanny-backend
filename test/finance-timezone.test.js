import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { setupDb, teardownDb, clearDb } from './helpers.js';
import { costSummary } from '../src/services/finance.js';
import { Cost } from '../src/models/index.js';
import config from '../src/config/index.js';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * A month must begin when it begins in Bali, not on the server.
 *
 * The date ranges used a bare `dayjs()`, which reads the server's timezone. The
 * server runs UTC and the business runs UTC+8, so every reporting window opened
 * eight hours late: anything between midnight and 8am on the 1st fell into the
 * month before. Small on most days, and wrong exactly at a month end, when the
 * figures are being closed off and checked against the bank.
 */

before(setupDb);
after(teardownDb);
beforeEach(clearDb);

const TZ = config.timezone;

test('a cost just after midnight in Bali belongs to the new month', async () => {
  // 1 October, 02:00 in Bali — which is still 30 September in UTC.
  const justAfterMidnight = dayjs.tz('2026-10-01 02:00', TZ).toDate();

  await Cost.create({
    spentOn: justAfterMidnight,
    category: 'transport',
    description: 'Petrol, early morning run',
    amount: 150000,
  });

  const october = await costSummary({ from: '2026-10-01', to: '2026-10-31' });
  assert.equal(october.total, 150000, 'it must fall inside October');

  const september = await costSummary({ from: '2026-09-01', to: '2026-09-30' });
  assert.equal(september.total, 0, 'and must not also appear in September');
});

test('a cost late on the last night of the month stays in that month', async () => {
  // The other edge: 30 September, 23:00 Bali is already 1 October in UTC+8's
  // favour on a naive server, so this guards the opposite mistake.
  const lastNight = dayjs.tz('2026-09-30 23:00', TZ).toDate();

  await Cost.create({
    spentOn: lastNight,
    category: 'supplies',
    description: 'Late delivery',
    amount: 90000,
  });

  const september = await costSummary({ from: '2026-09-01', to: '2026-09-30' });
  assert.equal(september.total, 90000, 'it belongs to September');

  const october = await costSummary({ from: '2026-10-01', to: '2026-10-31' });
  assert.equal(october.total, 0, 'not October');
});

test('a single chosen day covers that whole day in Bali', async () => {
  // Someone picking "5 October" in the dashboard means the whole of the 5th as
  // the office lives it, 00:00 to 23:59 Bali — not 08:00 to 08:00.
  const earlyMorning = dayjs.tz('2026-10-05 01:00', TZ).toDate();
  const lateEvening = dayjs.tz('2026-10-05 22:30', TZ).toDate();

  await Cost.create({
    spentOn: earlyMorning, category: 'transport', description: 'Dawn trip', amount: 40000,
  });
  await Cost.create({
    spentOn: lateEvening, category: 'transport', description: 'Night trip', amount: 60000,
  });

  const theFifth = await costSummary({ from: '2026-10-05', to: '2026-10-05' });
  assert.equal(theFifth.total, 100000, 'both ends of the day are inside it');
});
