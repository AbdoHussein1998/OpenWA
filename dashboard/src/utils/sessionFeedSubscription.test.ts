import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_FEED_EVENTS,
  createSessionFeedState,
  noteSessionFeedError,
  subscribeSessionFeed,
} from './sessionFeedSubscription.ts';

interface SentSubscribe {
  sessionId: string;
  events: string[];
}

interface MockSink {
  sent: SentSubscribe[];
  subscribe: (sessionId: string, events: string[]) => void;
}

/**
 * Minimal socket stand-in that captures subscribe emissions.
 */
function mockSink(): MockSink {
  const sent: SentSubscribe[] = [];

  return {
    sent,

    subscribe(sessionId: string, events: string[]): void {
      sent.push({
        sessionId,
        events,
      });
    },
  };
}

test('session feed includes all required realtime session events', () => {
  assert.deepEqual(
    [...SESSION_FEED_EVENTS],
    [
      'session.status',
      'session.qr',
      'session.restriction',
      'session.connection_stage',
    ],
  );
});

test('unrestricted path subscribes the wildcard room once', () => {
  const sink = mockSink();
  const state = createSessionFeedState();

  subscribeSessionFeed(
    sink,
    state,
    ['s1', 's2'],
  );

  assert.deepEqual(
    sink.sent,
    [
      {
        sessionId: '*',
        events: [...SESSION_FEED_EVENTS],
      },
    ],
  );
});

test('FORBIDDEN_SESSION error frame triggers the per-session fallback', () => {
  const sink = mockSink();
  const state = createSessionFeedState();

  // First try the wildcard room.
  subscribeSessionFeed(
    sink,
    state,
    ['s1', 's2'],
  );

  // A scoped API key cannot subscribe to "*", so switch to per-session mode.
  assert.equal(
    noteSessionFeedError(
      state,
      'FORBIDDEN_SESSION',
    ),
    true,
  );

  subscribeSessionFeed(
    sink,
    state,
    ['s1', 's2'],
  );

  assert.deepEqual(
    sink.sent.map(message => message.sessionId),
    ['*', 's1', 's2'],
  );

  assert.deepEqual(
    sink.sent[1]?.events,
    [...SESSION_FEED_EVENTS],
  );

  assert.deepEqual(
    sink.sent[2]?.events,
    [...SESSION_FEED_EVENTS],
  );
});

test('fallback is silent for unrelated errors and fires only once', () => {
  const sink = mockSink();
  const state = createSessionFeedState();

  subscribeSessionFeed(
    sink,
    state,
    ['s1'],
  );

  assert.equal(
    noteSessionFeedError(
      state,
      'UNAUTHORIZED',
    ),
    false,
  );

  assert.equal(
    noteSessionFeedError(
      state,
      'FORBIDDEN_SESSION',
    ),
    true,
  );

  // A duplicate rejection after fallback must not re-trigger the transition.
  assert.equal(
    noteSessionFeedError(
      state,
      'FORBIDDEN_SESSION',
    ),
    false,
  );

  subscribeSessionFeed(
    sink,
    state,
    ['s1'],
  );

  // Re-running with the same list must not subscribe s1 again.
  subscribeSessionFeed(
    sink,
    state,
    ['s1'],
  );

  assert.deepEqual(
    sink.sent.map(message => message.sessionId),
    ['*', 's1'],
  );

  assert.deepEqual(
    sink.sent[1]?.events,
    [...SESSION_FEED_EVENTS],
  );
});

test('per-session mode subscribes only newly listed sessions', () => {
  const sink = mockSink();
  const state = createSessionFeedState();

  // Wildcard subscription still happens even when the initial session list is empty.
  subscribeSessionFeed(
    sink,
    state,
    [],
  );

  assert.equal(
    noteSessionFeedError(
      state,
      'FORBIDDEN_SESSION',
    ),
    true,
  );

  subscribeSessionFeed(
    sink,
    state,
    ['s1'],
  );

  // s1 is already subscribed, so only the newly-added s2 should be emitted.
  subscribeSessionFeed(
    sink,
    state,
    ['s1', 's2'],
  );

  assert.deepEqual(
    sink.sent.map(message => message.sessionId),
    ['*', 's1', 's2'],
  );

  assert.deepEqual(
    sink.sent[1]?.events,
    [...SESSION_FEED_EVENTS],
  );

  assert.deepEqual(
    sink.sent[2]?.events,
    [...SESSION_FEED_EVENTS],
  );
});