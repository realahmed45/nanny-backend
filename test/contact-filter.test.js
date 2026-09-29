import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactContactDetails } from '../src/utils/contactFilter.js';

/**
 * What survives redaction matters as much as what does not.
 *
 * The filter used to replace the whole message whenever it flagged something it
 * had no rule to remove — so a message naming a platform lost everything around
 * it, including a child's allergy. These pin both halves: contact details go,
 * and the sentence carrying them stays.
 */

test('a message is not destroyed because it names a platform', () => {
  const said = 'Aisha has a peanut allergy and carries an EpiPen. Telegram me if problems';
  const { text, redacted } = redactContactDetails(said);

  assert.ok(redacted, 'the handle is still caught');
  assert.match(text, /peanut allergy/, 'the allergy survives');
  assert.match(text, /EpiPen/, 'and so does the instruction');
  assert.notEqual(text, '[removed]', 'the message is not replaced wholesale');
});

test('every platform name is removed without taking the sentence with it', () => {
  for (const word of ['instagram', 'telegram', 'signal', 'wechat', 'snapchat', 'facebook', 'ig']) {
    const { text } = redactContactDetails(`please bring the stroller, my ${word} is janed`);
    assert.match(text, /stroller/, `"${word}" must not destroy the message`);
    assert.doesNotMatch(text, new RegExp(word, 'i'), `"${word}" itself is removed`);
  }
});

test('a bare @handle goes, and an ordinary "at" stays', () => {
  assert.match(redactContactDetails('add me @nannyjane').text, /\[removed\]/);
  const meeting = redactContactDetails('meet me @ the gate at 8.30');
  assert.equal(meeting.redacted, false, 'a lone @ is not a handle');
  assert.equal(meeting.text, 'meet me @ the gate at 8.30');
});

test('phone numbers still go, however they are written', () => {
  for (const said of [
    '081234567890',
    '0812 3456 7890',
    '+62 812 3456 7890',
    'call me on zero eight one two three four five six seven eight',
    'nol delapan satu dua tiga empat lima enam tujuh delapan',
  ]) {
    const { text, redacted } = redactContactDetails(said);
    assert.ok(redacted, said);
    assert.match(text, /\[removed\]/, said);
  }
});

test('a spelled-out number broken up by a word is still caught', () => {
  // One ordinary word in the middle resets the run, splitting eight digits into
  // a four and a six — under the run threshold twice over. It went through in
  // full until the total was counted as well and joining words were removed
  // before the digit check.
  for (const said of [
    'zero eight one two, then three four five six seven eight',
    'eight one two three and four five six seven',
    'nol delapan satu dua dan tiga empat lima enam',
  ]) {
    const { redacted } = redactContactDetails(said);
    assert.ok(redacted, said);
  }
});

test('two separate times are not a phone number', () => {
  // The obvious over-correction: removing everything between digits collapses
  // "08:30 ... 17:00" into eight digits and destroys an ordinary message about
  // working hours.
  const said = 'I will arrive at 08:30 and leave at 17:00';
  const { text, redacted } = redactContactDetails(said);
  assert.equal(redacted, false, said);
  assert.equal(text, said);
});

test('a spelled-out number leaves the words around it intact', () => {
  const { text } = redactContactDetails('call me on zero eight one two three four five six seven eight');
  assert.match(text, /^call me on/, 'the sentence keeps its opening');
});

test('scattered number words are not a phone number', () => {
  // The guard meant to require a run of digits read `run >= 0`, so it never
  // fired, and ordinary counting was folded into something that matched.
  for (const said of [
    'I have one child and two dogs',
    'Please bring 2 bottles, 3 diapers, 4 toys, 5 books',
    'I have 2 kids aged 3 and 5',
    'she is four years old and starts at eight',
  ]) {
    const { text, redacted } = redactContactDetails(said);
    assert.equal(redacted, false, said);
    assert.equal(text, said, said);
  }
});

test('the things families and nannies actually write are left alone', () => {
  for (const said of [
    'I live at house number 12, Jalan Melati',
    'See you at 8.30',
    'My son is 4 years old',
    'The price is Rp 150.000 per hour',
    'I will arrive at 08:30 and leave at 17:00',
    "I'm at Jl. Sudirman no. 45, RT 03 RW 08",
  ]) {
    const { text, redacted } = redactContactDetails(said);
    assert.equal(redacted, false, said);
    assert.equal(text, said, said);
  }
});
