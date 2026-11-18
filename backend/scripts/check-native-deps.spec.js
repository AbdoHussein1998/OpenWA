const test = require('node:test');
const assert = require('node:assert/strict');
const { checkNativeBinding, run } = require('./check-native-deps.js');

test('opens in-memory SQLite, runs a SQL query and closes it', () => {
  let closed = 0;
  class FakeDriver {
    constructor(filename) { assert.equal(filename, ':memory:'); }
    prepare(sql) { assert.equal(sql, 'SELECT 1 AS healthy'); return { get: () => ({ healthy: 1 }) }; }
    close() { closed++; }
  }
  assert.deepEqual(checkNativeBinding(() => FakeDriver), { ok: true });
  assert.equal(closed, 1);
});

test('reports a missing .node binary as a clean diagnostic result', () => {
  const result = checkNativeBinding(() => {
    throw new Error('Could not locate the bindings file. Tried:\n a/b/c');
  });
  assert.deepEqual(result, { ok: false, reason: 'Could not locate the bindings file. Tried:' });
});

test('rejects unusable native driver results and closes the handle', () => {
  let closed = 0;
  class BrokenDriver {
    prepare() { return { get: () => ({ healthy: 0 }) }; }
    close() { closed++; }
  }
  assert.match(checkNativeBinding(() => BrokenDriver).reason, /unexpected result/);
  assert.equal(closed, 1);
});

test('the CLI returns failure and actionable repair steps', () => {
  const errors = [];
  const original = console.error;
  console.error = msg => errors.push(msg);
  try {
    assert.equal(run(() => { throw new Error('native binary missing'); }), 1);
    assert.match(errors.join('\n'), /rebuild better-sqlite3/);
    assert.match(errors.join('\n'), /Do not delete data/);
  } finally {
    console.error = original;
  }
});


test('a failure to close the native SQLite handle also fails the preflight', () => {
  class CloseFails {
    prepare() { return { get: () => ({ healthy: 1 }) }; }
    close() { throw new Error('close failed'); }
  }
  assert.match(checkNativeBinding(() => CloseFails).reason, /could not close: close failed/);
});
