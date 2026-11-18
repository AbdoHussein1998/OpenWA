import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isThrottlerError, retryWithBackoff } from './retryWithBackoff.ts';

test('recognizes HTTP 429', () => {
  assert.equal(isThrottlerError({ status: 429 }), true);
  assert.equal(isThrottlerError({ response: { status: 429 } }), true);
  assert.equal(isThrottlerError({ statusCode: 429 }), true);
});

test('recognizes ThrottlerException messages', () => {
  assert.equal(isThrottlerError(new Error('ThrottlerException')), true);
  assert.equal(isThrottlerError(new Error('Too Many Requests')), true);
  assert.equal(isThrottlerError(new Error('rate limit exceeded')), true);
});

test('does not classify unrelated errors as throttling', () => {
  assert.equal(isThrottlerError(new Error('Unauthorized')), false);
  assert.equal(isThrottlerError({ status: 500 }), false);
});

test('retries retryable errors and eventually succeeds', async () => {
  let attempts = 0;

  const result = await retryWithBackoff(
    async () => {
      attempts += 1;

      if (attempts < 3) {
        throw { status: 429 };
      }

      return 'ok';
    },
    {
      baseMs: 0,
      maxAttempts: 3,
      isRetryable: isThrottlerError,
    },
  );

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('stops immediately on a non-retryable error', async () => {
  let attempts = 0;
  const failure = new Error('bad request');

  await assert.rejects(
    retryWithBackoff(
      async () => {
        attempts += 1;
        throw failure;
      },
      {
        baseMs: 0,
        maxAttempts: 3,
        isRetryable: isThrottlerError,
      },
    ),
    error => error === failure,
  );

  assert.equal(attempts, 1);
});

test('throws the final error after exhausting attempts', async () => {
  let attempts = 0;
  const failure = { status: 429 };

  await assert.rejects(
    retryWithBackoff(
      async () => {
        attempts += 1;
        throw failure;
      },
      {
        baseMs: 0,
        maxAttempts: 3,
        isRetryable: isThrottlerError,
      },
    ),
    error => error === failure,
  );

  assert.equal(attempts, 3);
});
