'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyGatingGuard, UNGUARDED_CALL, GUARDED_CALL } = require('./patch-wwebjs-status-gating');

/**
 * The patcher rewrites a file this repository does not own, so what has to hold is that it only
 * ever fires on the exact shape it was written for. A transform that silently does nothing (or
 * half-applies to a changed upstream) would ship a build whose status posting is still broken,
 * which is the failure this patch exists to prevent.
 */

/** A throwaway whatsapp-web.js tree containing just the file the patcher edits. */
function fakeWwjs(utilsSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-gating-'));
  const utilsDir = path.join(dir, 'src', 'util', 'Injected');
  fs.mkdirSync(utilsDir, { recursive: true });
  fs.writeFileSync(path.join(utilsDir, 'Utils.js'), utilsSource);
  return { dir, utilsFile: path.join(utilsDir, 'Utils.js') };
}

const withCall = (call) => `exports.x = () => {\n    const msg = new Model({\n${call}\n    });\n};\n`;

test('guards the unguarded call', () => {
  const { dir, utilsFile } = fakeWwjs(withCall(UNGUARDED_CALL));

  const result = applyGatingGuard(dir);

  assert.equal(result.skipped, false);
  const patched = fs.readFileSync(utilsFile, 'utf8');
  assert.ok(patched.includes(GUARDED_CALL));
  assert.ok(!patched.includes(UNGUARDED_CALL));
});

test('is idempotent — a second run is a no-op, not a double patch', () => {
  const { dir, utilsFile } = fakeWwjs(withCall(UNGUARDED_CALL));
  applyGatingGuard(dir);
  const once = fs.readFileSync(utilsFile, 'utf8');

  const result = applyGatingGuard(dir);

  assert.equal(result.skipped, true);
  assert.equal(fs.readFileSync(utilsFile, 'utf8'), once);
});

/**
 * The important one. If upstream changes the call, the patcher must refuse loudly rather than leave
 * the file untouched and report success — a silent skip ships a build that still throws on every
 * status post, and nothing downstream would notice until a user tried to post one.
 */
test('refuses an upstream shape it does not recognise', () => {
  const { dir, utilsFile } = fakeWwjs(withCall('                    cannotBeRanked: somethingElse(),'));
  const before = fs.readFileSync(utilsFile, 'utf8');

  assert.throws(() => applyGatingGuard(dir), /unsupported Utils\.js shape/);
  assert.equal(fs.readFileSync(utilsFile, 'utf8'), before, 'must not modify a file it did not understand');
});

test('refuses when the call appears more than once', () => {
  const { dir } = fakeWwjs(withCall(UNGUARDED_CALL) + withCall(UNGUARDED_CALL));

  assert.throws(() => applyGatingGuard(dir), /unguarded calls: 2/);
});

test('reports a missing whatsapp-web.js rather than pretending to patch it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-gating-empty-'));

  assert.throws(() => applyGatingGuard(dir), /Utils\.js not found/);
});

/**
 * The guard has to preserve behaviour where the helper still exists — otherwise the patch would
 * silently change what WhatsApp records for every status on builds that were working fine. Asserted
 * on the snippet's shape rather than by evaluating it: this is generated code destined for a
 * browser page, and building a function out of a string to test it is not worth the hazard.
 */
test('calls the helper when present and falls back to false, rather than replacing it outright', () => {
  assert.ok(
    GUARDED_CALL.includes("typeof gating?.canCheckStatusRankingPosterGating === 'function'"),
    'must still call the real helper when the build provides it',
  );
  assert.ok(GUARDED_CALL.includes('gating.canCheckStatusRankingPosterGating()'), 'helper result is used as-is');
  assert.ok(GUARDED_CALL.includes(': false'), 'absent helper falls back to the pre-gating meaning');
  assert.ok(GUARDED_CALL.includes('catch'), 'a throwing require must not take the status post down');
});
