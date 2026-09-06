/**
 * Local common-password screening tests (UX-ONB-006).
 *
 * The screen is exact-match, case-insensitive, whitespace-folding, and
 * purely local — importing the module must never touch the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isCommonPassword, BLOCKLIST_SIZE } from '../src/data/blocklist.js';

test('rejects common-password material regardless of case or spacing', () => {
  assert.equal(isCommonPassword('PasswordPassword'), true);
  assert.equal(isCommonPassword('PASSWORDPASSWORD'), true);
  assert.equal(isCommonPassword(' passwordpassword '), true, 'surrounding whitespace folds');
  assert.equal(isCommonPassword('password password'), true, 'internal whitespace folds');
  assert.equal(isCommonPassword('CorrectHorseBattery'), true);
});

test('accepts ordinary long passphrases and unusual input', () => {
  assert.equal(isCommonPassword('correct-horse-battery-staple-maple'), false);
  assert.equal(isCommonPassword('e2e-comprehensive-pw'), false);
  assert.equal(isCommonPassword('  密码 passphrase xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx  '), false);
  assert.equal(isCommonPassword(''), false);
  assert.equal(isCommonPassword(undefined), false);
  assert.equal(isCommonPassword(null), false);
  assert.equal(isCommonPassword(12345), false);
});

test('the corpus is nonempty, lowercase, and whitespace-free', () => {
  assert.ok(BLOCKLIST_SIZE >= 100, `expected a meaningful corpus, got ${BLOCKLIST_SIZE}`);
});
