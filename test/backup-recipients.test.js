import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, clearDb } from './helpers.js';
import { Setting } from '../src/models/index.js';

/**
 * Who the nightly backup reaches.
 *
 * It went to one hardcoded personal address. If that person left, changed it,
 * or let the inbox fill, every backup stopped arriving and nothing said so —
 * which is only discovered on the day it is needed.
 */

before(setupDb);
after(teardownDb);
beforeEach(clearDb);

/** The settings service caches for 30s, so each case needs a fresh module. */
async function recipientsAfter(value) {
  await Setting.findOneAndUpdate(
    { key: 'backupRecipients' },
    { key: 'backupRecipients', value },
    { upsert: true },
  );
  const mod = await import(`../src/services/settings.js?t=${Date.now()}`);
  return mod.backupRecipients();
}

test('everyone listed receives it', async () => {
  const list = await recipientsAfter([
    { email: 'owner@example.com', label: 'Owner' },
    { email: 'finance@example.com', label: 'Finance' },
  ]);
  assert.deepEqual(list, ['owner@example.com', 'finance@example.com']);
});

test('an empty list falls back to the configured address, and there is no built-in one', async () => {
  // Removing everybody falls back to BACKUP_EMAIL. There is deliberately no
  // hard-coded default any more: it was a personal inbox receiving every
  // customer's details each night.
  const config = (await import('../src/config/index.js')).default;
  const list = await recipientsAfter([]);
  if (config.backup.email) {
    assert.equal(list.length, 1, 'one fallback address');
    assert.ok(list[0].includes('@'));
  } else {
    assert.deepEqual(list, []);
  }
});

test('the same address twice is only sent once', async () => {
  const list = await recipientsAfter([
    { email: 'owner@example.com' },
    { email: 'OWNER@example.com' },
    { email: '  owner@example.com  ' },
  ]);
  assert.deepEqual(list, ['owner@example.com'], 'deduplicated and lowercased');
});

test('entries with no usable address are ignored', async () => {
  const list = await recipientsAfter([
    { email: 'good@example.com' },
    { email: '   ' },
    { email: 'not-an-email' },
    {},
  ]);
  assert.deepEqual(list, ['good@example.com']);
});
