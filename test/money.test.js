import test from 'node:test';
import assert from 'node:assert/strict';
import { money } from '../src/utils/format.js';
import config from '../src/config/index.js';

/**
 * Amounts are stored as rupiah figures. A currency code does not convert them,
 * so labelling one "USD" turns Rp 16,220,000 into a price wrong by roughly
 * fifteen thousand times — on the calendar, and in every quote sent to a
 * family or a nanny over WhatsApp.
 */

test('money writes rupiah the way Indonesia writes it', () => {
  assert.equal(money(147000), 'Rp 147,000');
  assert.equal(money(16220000), 'Rp 16,220,000');
  assert.equal(money(0), 'Rp 0');
});

test('an unsupported currency still prints rupiah, never a foreign unit', () => {
  // CURRENCY=USD was set in the hosting dashboard and relabelled every price.
  assert.equal(money(16220000, 'USD'), 'Rp 16,220,000');
  assert.equal(money(500000, 'EUR'), 'Rp 500,000');
  assert.equal(money(500000, ''), 'Rp 500,000');
  assert.equal(money(500000, undefined), 'Rp 500,000');
});

test('config pins the currency regardless of the environment', () => {
  assert.equal(config.currency, 'IDR');
});
