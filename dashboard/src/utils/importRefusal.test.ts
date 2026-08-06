import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldOfferStopOrphansRetry } from './importRefusal.ts';

// The retry this predicate gates is DESTRUCTIVE: it re-POSTs the replace-all with stopOrphans=true,
// which tears down live engines. Branching on the 409 status alone offered that retry from a dialog
// whose message says "another import is already running; wait for it" — so OK read as an
// acknowledgement and ran a second full replace nobody asked for.

test('offers the retry for the orphan-engine refusal, which is a real decision', () => {
  assert.equal(shouldOfferStopOrphansRetry(409, undefined, false), true);
});

test('never offers the retry when another import is already running', () => {
  assert.equal(shouldOfferStopOrphansRetry(409, 'IMPORT_ALREADY_RUNNING', false), false);
});

test('does not loop: a 409 on the retry itself is not offered again', () => {
  assert.equal(shouldOfferStopOrphansRetry(409, undefined, true), false);
});

test('leaves every other status alone', () => {
  assert.equal(shouldOfferStopOrphansRetry(413, undefined, false), false);
  assert.equal(shouldOfferStopOrphansRetry(500, undefined, false), false);
  assert.equal(shouldOfferStopOrphansRetry(undefined, undefined, false), false);
});

test('never offers the retry when another transaction holds the connection', () => {
  assert.equal(shouldOfferStopOrphansRetry(409, 'IMPORT_NESTED_TRANSACTION', false), false);
});

test('an unknown future 409 code does not get the destructive retry', () => {
  // The non-offered branch is not silence — the caller still toasts the server's message — so the
  // safe default is to withhold a retry that stops live engines and replaces every table again.
  assert.equal(shouldOfferStopOrphansRetry(409, 'SOME_FUTURE_CODE', false), false);
});
