import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTime, parseDate, parseMoney, parseEmail, parseMultiChoice,
  parseWeekdays, parseYesNo, detectCommand, parseMapUrl, parseChoice,
} from '../src/utils/parse.js';

test('parseTime handles the formats families type', () => {
  assert.equal(parseTime('9 AM'), '09:00');
  assert.equal(parseTime('9:00 AM'), '09:00');
  assert.equal(parseTime('9am'), '09:00');
  assert.equal(parseTime('12 AM'), '00:00');
  assert.equal(parseTime('12 PM'), '12:00');
  assert.equal(parseTime('5 PM'), '17:00');
  assert.equal(parseTime('21:30'), '21:30');
  assert.equal(parseTime('banana'), null);
  assert.equal(parseTime('25:00'), null);
});

test('parseDate handles "12 August" and ISO, never returning a past date', () => {
  const ref = new Date('2026-08-01T00:00:00Z');
  assert.equal(parseDate('12 August', ref), '2026-08-12');
  assert.equal(parseDate('2026-09-05', ref), '2026-09-05');
  assert.equal(parseDate('12 Aug 2027', ref), '2027-08-12');
  // A day already past this year rolls to next year.
  assert.equal(parseDate('12 July', ref), '2027-07-12');
  assert.equal(parseDate('not a date', ref), null);
});

test('parseMoney strips currency symbols', () => {
  assert.equal(parseMoney('$25'), 25);
  assert.equal(parseMoney('45.50'), 45.5);
  assert.equal(parseMoney('25 USD'), 25);
  assert.equal(parseMoney('abc'), null);
});

test('parseEmail unwraps markdown mailto links', () => {
  assert.equal(parseEmail('sarah@email.com'), 'sarah@email.com');
  assert.equal(parseEmail('[sarah@email.com](mailto:sarah@email.com)'), 'sarah@email.com');
  assert.equal(parseEmail('nope'), null);
});

test('parseMultiChoice validates ranges and dedupes', () => {
  assert.deepEqual(parseMultiChoice('1,2', 4), [1, 2]);
  assert.deepEqual(parseMultiChoice('1, 3 ,4', 4), [1, 3, 4]);
  assert.deepEqual(parseMultiChoice('2,2', 4), [2]);
  assert.equal(parseMultiChoice('1,5', 4), null, 'out of range rejected');
  assert.equal(parseMultiChoice('x', 4), null);
});

test('parseWeekdays accepts indices and names', () => {
  assert.deepEqual(parseWeekdays('1,2,3'), ['Monday', 'Tuesday', 'Wednesday']);
  assert.deepEqual(parseWeekdays('Monday, Tuesday'), ['Monday', 'Tuesday']);
  assert.equal(parseWeekdays('Funday'), null);
});

test('commands and yes/no', () => {
  assert.equal(detectCommand('0'), 'MAIN_MENU');
  assert.equal(detectCommand('BYE'), 'BYE');
  assert.equal(detectCommand('back'), 'BACK');
  assert.equal(detectCommand('hello'), null);
  assert.equal(parseYesNo('1'), true);
  assert.equal(parseYesNo('No'), false);
  assert.equal(parseYesNo('maybe'), null);
});

test('parseMapUrl accepts links or None', () => {
  assert.deepEqual(parseMapUrl('None'), { none: true, url: null });
  assert.deepEqual(parseMapUrl('https://maps.google.com/x'), { none: false, url: 'https://maps.google.com/x' });
  assert.equal(parseMapUrl('garbage'), null);
  assert.equal(parseChoice('3', 3), 3);
  assert.equal(parseChoice('4', 3), null);
});

test('parseDate accepts relative words, weekdays and any date format', () => {
  // A fixed Tuesday, so weekday maths is checkable rather than guesswork.
  const tue = new Date('2026-09-01T12:00:00');

  assert.equal(parseDate('today', tue), '2026-09-01');
  assert.equal(parseDate('tomorrow', tue), '2026-09-02');
  assert.equal(parseDate('tmrw', tue), '2026-09-02');
  assert.equal(parseDate('day after tomorrow', tue), '2026-09-03');

  // A weekday means the NEXT one, so asking on Tuesday for "monday" is the
  // coming Monday, and "tuesday" is a week away rather than today.
  assert.equal(parseDate('monday', tue), '2026-09-07');
  assert.equal(parseDate('Monday', tue), '2026-09-07');
  assert.equal(parseDate('next monday', tue), '2026-09-07');
  assert.equal(parseDate('mon', tue), '2026-09-07');
  assert.equal(parseDate('tuesday', tue), '2026-09-08', 'same weekday means next week');
  assert.equal(parseDate('sunday', tue), '2026-09-06');

  // The same date typed every plausible way.
  for (const text of ['12 October', '12 oct', 'October 12', 'oct 12', '12 October.', '12/10']) {
    assert.equal(parseDate(text, tue), '2026-10-12', `failed on "${text}"`);
  }
  assert.equal(parseDate('2026-10-12', tue), '2026-10-12');
  assert.equal(parseDate('12/10/2026', tue), '2026-10-12');

  // A month already past rolls into next year rather than the past.
  assert.equal(parseDate('12 August', tue), '2027-08-12');

  // Nonsense is refused rather than silently becoming a wrong date: dayjs
  // used to read "12 augustus" as the year 2001.
  assert.equal(parseDate('12 augustus', tue), null);
  assert.equal(parseDate('garbage', tue), null);
  assert.equal(parseDate('32 August', tue), null);
  assert.equal(parseDate('', tue), null);
});
