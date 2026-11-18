import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequestQueue } from './requestQueue.ts';

test('runs queued tasks sequentially in FIFO order', async () => {
  const events: string[] = [];
  const queue = createRequestQueue(0);

  const first = queue.enqueue(async () => {
    events.push('start-A');
    await Promise.resolve();
    events.push('end-A');
    return 'A';
  });

  const second = queue.enqueue(async () => {
    events.push('start-B');
    events.push('end-B');
    return 'B';
  });

  assert.equal(await first, 'A');
  assert.equal(await second, 'B');
  assert.deepEqual(events, ['start-A', 'end-A', 'start-B', 'end-B']);

  queue.clear();
});

test('continues processing after a task rejects', async () => {
  const queue = createRequestQueue(0);
  const failure = new Error('boom');

  const first = queue.enqueue(async () => {
    throw failure;
  });

  const second = queue.enqueue(async () => 'ok');

  await assert.rejects(first, error => error === failure);
  assert.equal(await second, 'ok');

  queue.clear();
});

test('clear rejects work that has not started yet', async () => {
  const queue = createRequestQueue(0);

  const first = queue.enqueue(async () => new Promise<string>(() => {}));
  const second = queue.enqueue(async () => 'never');

  const clearError = new Error('cleared');
  queue.clear(clearError);

  await assert.rejects(second, error => error === clearError);

  // The currently running task is intentionally not cancelled.
  // Clear only affects pending work.
  void first.catch(() => undefined);
});

test('enforces the configured gap between dispatches', async () => {
  const queue = createRequestQueue(25);
  const starts: number[] = [];

  const first = queue.enqueue(async () => {
    starts.push(Date.now());
  });

  const second = queue.enqueue(async () => {
    starts.push(Date.now());
  });

  await Promise.all([first, second]);

  assert.ok(starts[1] - starts[0] >= 20);

  queue.clear();
});
