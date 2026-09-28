import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectOpeningIntent } from '../src/utils/parse.js';

/**
 * What a stranger's first message is taken to mean.
 *
 * Only the word "nanny" used to wake the bot, so "I need a babysitter" and
 * "saya mau kerja" were logged and never answered. These pin both halves: that
 * real openings are recognised, and that a wrong number still gets silence.
 */

test('a nanny offering to work is recognised', () => {
  const said = [
    'I am a nanny ,, i am looking for a job',
    'I am a nanny',
    "I'm a nanny and I need work",
    'looking for a job',
    'I need work',
    'do you have any job for me',
    'any vacancy?',
    'hire me please',
    'I am a babysitter looking for a job',
    'I would like to apply for a nanny job',
  ];
  for (const text of said) {
    assert.equal(detectOpeningIntent(text), 'nanny', text);
  }
});

test('"work as a nanny" is her offering, not a parent asking', () => {
  // Every care pattern sees want/looking next to "nanny" here. The sentence
  // means the opposite, and she is the one this feature exists for.
  assert.equal(detectOpeningIntent('I want to work as a nanny'), 'nanny');
  assert.equal(detectOpeningIntent('looking for a job as a babysitter'), 'nanny');
  assert.equal(detectOpeningIntent('I would like to apply as a nanny'), 'nanny');
});

test('Indonesian openings are recognised', () => {
  // The workforce writes this far more often than the English equivalent.
  const said = [
    'saya mau kerja',
    'saya cari kerjaan',
    'ada lowongan?',
    'saya seorang pengasuh',
    'butuh kerja pak',
  ];
  for (const text of said) {
    assert.equal(detectOpeningIntent(text), 'nanny', text);
  }
});

test('a family wanting childcare is recognised, and never sent to signup', () => {
  const said = [
    'I need a babysitter',
    'i need childcare for my son',
    'looking for a nanny',
    'I am looking for a nanny for my daughter',
    'can you help me find someone for my baby',
    'I want to book a nanny',
    'how much is a nanny per hour',
    'butuh pengasuh anak',
    'cari baby sitter untuk anak saya',
  ];
  for (const text of said) {
    assert.equal(detectOpeningIntent(text), 'family', text);
  }
});

test('a bare greeting carries no intent of its own', () => {
  // These never reach the detector in practice — the trigger word still gates
  // the conversation — but a greeting must never be read as wanting work.
  for (const text of ['hi', 'Hello', 'hey!', 'good morning', 'selamat pagi', 'halo']) {
    assert.notEqual(detectOpeningIntent(text), 'nanny', text);
  }
});

test('a message that is not meant for us is still met with silence', () => {
  // The cost of answering these is a WhatsApp message to a wrong number, and
  // the cost of answering spam is answering spam.
  const said = [
    'Is this the right number for the laundry?',
    'WIN A FREE IPHONE CLICK HERE',
    'what is your address',
    '12345',
    'ok',
    'thanks',
    '',
  ];
  for (const text of said) {
    assert.equal(detectOpeningIntent(text), null, text);
  }
});

test('the trigger word alone carries no intent of its own', () => {
  // "nanny" still wakes the bot through isStartWord; it just says nothing
  // about who is typing, so the role picker is still the right next question.
  assert.equal(detectOpeningIntent('nanny'), null);
});
