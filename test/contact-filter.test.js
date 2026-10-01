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

/**
 * Bug #8: the detector flattened the message (spaces, dots, "and" stripped),
 * found eight digits across separate times or dates, could not find them in
 * the real text, and replaced the whole message with "[removed]". Each of these
 * came out as that single word.
 */
test('medicine times, meal times and allergies survive intact', () => {
  for (const said of [
    'Give Emma her medicine at 10.00 and 14.00, she has a nut allergy',
    'Kids eat at 12.30 and 18.30. Leo is allergic to peanuts, EpiPen in the kitchen drawer',
    'Booking dates 12/10/2026 and 14/10/2026 please bring snacks',
    'Kids eat at 12.30 18.30 19.00, nap 13:00 15:00',
    'Booking 2026-10-12 to 2026-10-14, or 12 Oct to 14 Oct',
    'Wake at 9am, lunch 12:30, medicine 10.00 14.00 18.00 22.00',
    'Salary Rp 1.500.000 plus Rp 150.000 transport, 150,000 for food',
    'Leo is 4, Emma is 7, we are at Jl. Melati no. 12, RT 03 RW 08',
  ]) {
    const { text, redacted, kinds } = redactContactDetails(said);
    assert.equal(text, said, said);
    assert.equal(redacted, false, said);
    assert.deepEqual(kinds, [], said);
  }
});

test('spelled digits are cut in place, never the whole message', () => {
  const bare = redactContactDetails('one one one one one one one one');
  assert.ok(bare.redacted);
  assert.ok(bare.kinds.includes('phone number'));

  const { text } = redactContactDetails(
    'Leo has a nut allergy. My number is one one one one one one one one, call me',
  );
  assert.equal(text, 'Leo has a nut allergy. My number is [removed], call me');
});

test('a phone number next to a safety instruction removes only the number', () => {
  const { text, redacted, kinds } = redactContactDetails(
    'Give Emma her medicine at 10.00, nut allergy. Call 0812 3456 7890 if worried',
  );
  assert.ok(redacted);
  assert.deepEqual(kinds, ['phone number']);
  assert.equal(text, 'Give Emma her medicine at 10.00, nut allergy. Call [removed] if worried');
});

test('every common way of writing a phone number is caught, in place', () => {
  for (const number of [
    '+62 812-3456-7890',
    '0812 3456 7890',
    '081234567890',
    '62812345678',
    '0812.3456.7890',
    '0812-3456-7890',
    '(0812) 3456 7890',
    '0 8 1 2 3 4 5 6 7 8 9 0',
    'nol delapan satu dua tiga empat lima enam tujuh delapan',
    'zero eight one two three four five six seven eight nine',
    'zero 8 one 2 three 4 five 6 seven 8',
  ]) {
    const said = `Hi bu, ${number} ok? Leo has asthma`;
    const { text, redacted, kinds } = redactContactDetails(said);
    assert.ok(redacted, number);
    assert.ok(kinds.includes('phone number'), number);
    assert.equal(text, 'Hi bu, [removed] ok? Leo has asthma', number);
  }
});

test('emails, links and handles go; the rest of the sentence stays', () => {
  const cases = [
    ['Leo has asthma, email me jane.doe+x@gmail.com thanks', 'email address'],
    ['Leo has asthma, chat at wa.me/6281234567890 thanks', 'contact handle'],
    ['Leo has asthma, chat at t.me/nannyjane thanks', 'contact handle'],
    ['Leo has asthma, see instagram.com/nannyjane thanks', 'contact handle'],
    ['Leo has asthma, add me @nannyjane thanks', 'contact handle'],
    ['Leo has asthma, telegram me thanks', 'contact handle'],
    ['Leo has asthma, ig: @nannyjane thanks', 'contact handle'],
    ['Leo has asthma, whatsapp me thanks', 'contact handle'],
    ['Leo has asthma, signal me thanks', 'contact handle'],
  ];
  for (const [said, kind] of cases) {
    const { text, redacted, kinds } = redactContactDetails(said);
    assert.ok(redacted, said);
    assert.ok(kinds.includes(kind), said);
    assert.match(text, /^Leo has asthma, /, said);
    assert.match(text, /\[removed\]/, said);
    assert.match(text, /thanks$/, said);
    assert.doesNotMatch(text, /nannyjane|gmail|6281234567890/, said);
  }
});

test('scattered spelled digits are reported but nothing is destroyed', () => {
  const said = 'zero eight one two, by the way, three four five six seven eight';
  const { text, kinds } = redactContactDetails(said);
  assert.ok(kinds.includes('phone number'), 'flagged for the caller');
  assert.match(text, /by the way/, 'the message survives');
});
