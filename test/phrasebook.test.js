import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PHRASES, PHRASE_KEYS, ALWAYS_STRICT, PHRASING, pickPhrase,
} from '../src/services/phrasebook.js';

test('strict mode gives the same wording every time', () => {
  const seen = new Set();
  for (let i = 0; i < 20; i += 1) {
    seen.add(pickPhrase('ASK_START_TIME', PHRASING.STRICT, {}));
  }
  assert.equal(seen.size, 1, 'strict must never vary');
  assert.equal([...seen][0], PHRASES.ASK_START_TIME.strict);
});

test('flexible mode uses more than one wording', () => {
  const seen = new Set();
  // Random selection, so this samples enough times that a single-wording
  // result means the pool is genuinely not being used.
  for (let i = 0; i < 200; i += 1) {
    seen.add(pickPhrase('ASK_START_TIME', PHRASING.FLEXIBLE, {}));
  }
  assert.ok(seen.size > 1, 'flexible should produce several wordings');
  for (const text of seen) {
    assert.ok(
      PHRASES.ASK_START_TIME.flexible.includes(text),
      'every wording must come from the written list, never invented',
    );
  }
});

test('sensitive questions stay strict even in flexible mode', () => {
  for (const key of ALWAYS_STRICT) {
    const entry = PHRASES[key];
    if (!entry?.strict) continue;
    for (let i = 0; i < 10; i += 1) {
      assert.equal(
        pickPhrase(key, PHRASING.FLEXIBLE, {}),
        entry.strict,
        `${key} must never be reworded`,
      );
    }
  }
});

test('every alternative keeps the placeholders its question needs', () => {
  for (const key of PHRASE_KEYS) {
    const entry = PHRASES[key];
    const needed = entry.placeholders || [];
    if (!needed.length || !Array.isArray(entry.flexible)) continue;

    for (const variant of entry.flexible) {
      for (const token of needed) {
        assert.ok(
          variant.includes(token),
          `${key}: a wording is missing ${token}, which would send a message with a blank in it`,
        );
      }
    }
  }
});

test('the strict wording is among the alternatives', () => {
  // So that turning flexibility on can still produce the original, rather
  // than guaranteeing the bot never says what it used to.
  for (const key of PHRASE_KEYS) {
    const entry = PHRASES[key];
    if (!Array.isArray(entry.flexible) || !entry.strict) continue;
    assert.ok(
      entry.flexible.includes(entry.strict),
      `${key}: the strict wording should be one of the alternatives`,
    );
  }
});

test('a question with a menu never varies below its first line', () => {
  // The numbered options are appended at send time. A variant carrying its
  // own options would end up with them twice, or renumbered.
  for (const key of PHRASE_KEYS) {
    const entry = PHRASES[key];
    if (!entry.hasOptions || !Array.isArray(entry.flexible)) continue;
    for (const variant of entry.flexible) {
      assert.ok(
        !/^\s*\d+[.)]/m.test(variant),
        `${key}: a menu question's wording must not contain its own numbered options`,
      );
    }
  }
});

test('an unknown question is refused rather than guessed at', () => {
  assert.equal(pickPhrase('NOT_A_REAL_KEY', PHRASING.FLEXIBLE, {}), null);
});

test('dashboard edits win over the wording in the code', () => {
  const overrides = {
    ASK_ADDRESS: { strict: 'Where exactly?', flexible: ['Where exactly?'] },
  };
  assert.equal(pickPhrase('ASK_ADDRESS', PHRASING.STRICT, overrides), 'Where exactly?');
  assert.equal(pickPhrase('ASK_ADDRESS', PHRASING.FLEXIBLE, overrides), 'Where exactly?');
});

test('a question with no alternatives falls back to its strict wording', () => {
  const overrides = { ASK_ADDRESS: { flexible: [] } };
  assert.equal(
    pickPhrase('ASK_ADDRESS', PHRASING.FLEXIBLE, overrides),
    PHRASES.ASK_ADDRESS.strict,
  );
});
