'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const {
  applyReadySyncPatch,
  PATCH_ERROR_CODES,
  FLAG_INIT_FIND,
  FLAG_INIT_REPLACE,
  ATTACH_MARK_FIND,
  ATTACH_MARK_REPLACE,
  HAS_SYNCED_FIND,
  HAS_SYNCED_REPLACE,
} = require('./patch-wwebjs-ready-sync');

/**
 * Same contract as the sibling patcher specs: this patcher rewrites dependency-owned code, so it
 * must apply only to the exact source shape it knows, be idempotent, reject partial/unknown trees,
 * and never write a half-patched Client.js.
 */

function fakeWwjs(clientSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-ready-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'Client.js'), clientSource);
  return { dir, clientFile: path.join(dir, 'src', 'Client.js') };
}

const withSnippets = (flagInit, attachMark, hasSynced) =>
  `class Client {\n    constructor() {\n${flagInit}\n    }\n    async inject() {\n${attachMark}\n${hasSynced}\n    }\n}\n`;

const PRISTINE = withSnippets(FLAG_INIT_FIND, ATTACH_MARK_FIND, HAS_SYNCED_FIND);

test('applies all three edits to a pristine upstream tree', () => {
  const { dir, clientFile } = fakeWwjs(PRISTINE);

  const result = applyReadySyncPatch(dir);

  assert.equal(result.skipped, false);
  const patched = fs.readFileSync(clientFile, 'utf8');
  for (const replacement of [FLAG_INIT_REPLACE, ATTACH_MARK_REPLACE, HAS_SYNCED_REPLACE]) {
    assert.ok(patched.includes(replacement));
  }
});

test('is idempotent — a second run is a no-op, not a double patch', () => {
  const { dir, clientFile } = fakeWwjs(PRISTINE);
  applyReadySyncPatch(dir);
  const once = fs.readFileSync(clientFile, 'utf8');

  const result = applyReadySyncPatch(dir);

  assert.equal(result.skipped, true);
  assert.equal(fs.readFileSync(clientFile, 'utf8'), once);
});

test('refuses an upstream shape it does not recognise and leaves the file untouched', () => {
  const { dir, clientFile } = fakeWwjs(
    withSnippets(FLAG_INIT_FIND, '        somethingElse();', HAS_SYNCED_FIND),
  );
  const before = fs.readFileSync(clientFile, 'utf8');

  assert.throws(
    () => applyReadySyncPatch(dir),
    error =>
      error instanceof Error &&
      error.code === PATCH_ERROR_CODES.UNSUPPORTED_SHAPE &&
      /unsupported Client\.js shape/.test(error.message),
  );
  assert.equal(fs.readFileSync(clientFile, 'utf8'), before);
});

test('refuses a partially patched tree and leaves the file untouched', () => {
  const { dir, clientFile } = fakeWwjs(
    withSnippets(FLAG_INIT_REPLACE, ATTACH_MARK_FIND, HAS_SYNCED_FIND),
  );
  const before = fs.readFileSync(clientFile, 'utf8');

  assert.throws(
    () => applyReadySyncPatch(dir),
    error => error instanceof Error && error.code === PATCH_ERROR_CODES.UNSUPPORTED_SHAPE,
  );
  assert.equal(fs.readFileSync(clientFile, 'utf8'), before);
});

test('refuses a tree containing both the unpatched and patched form', () => {
  const { dir, clientFile } = fakeWwjs(
    withSnippets(`${FLAG_INIT_FIND}\n${FLAG_INIT_REPLACE}`, ATTACH_MARK_FIND, HAS_SYNCED_FIND),
  );
  const before = fs.readFileSync(clientFile, 'utf8');

  assert.throws(
    () => applyReadySyncPatch(dir),
    error => error instanceof Error && error.code === PATCH_ERROR_CODES.UNSUPPORTED_SHAPE,
  );
  assert.equal(fs.readFileSync(clientFile, 'utf8'), before);
});

test('reports a completely absent whatsapp-web.js package distinctly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-ready-package-missing-'));
  const absentPackage = path.join(root, 'whatsapp-web.js');

  assert.throws(
    () => applyReadySyncPatch(absentPackage),
    error =>
      error instanceof Error &&
      error.code === PATCH_ERROR_CODES.PACKAGE_MISSING &&
      /package not found/.test(error.message),
  );
});

test('an installed package missing src/Client.js is fatal, not treated as package absence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-ready-target-missing-'));

  assert.throws(
    () => applyReadySyncPatch(dir),
    error =>
      error instanceof Error &&
      error.code === PATCH_ERROR_CODES.TARGET_MISSING &&
      /is installed but Client\.js was not found/.test(error.message),
  );
});

function installCliFixture(clientSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-ready-cli-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  const script = path.join(root, 'scripts', 'patch-wwebjs-ready-sync.js');
  fs.copyFileSync(path.join(__dirname, 'patch-wwebjs-ready-sync.js'), script);

  if (clientSource !== undefined) {
    const clientDir = path.join(root, 'node_modules', 'whatsapp-web.js', 'src');
    fs.mkdirSync(clientDir, { recursive: true });
    fs.writeFileSync(path.join(clientDir, 'Client.js'), clientSource);
  }

  return { root, script };
}

test('CLI: unsupported installed Client.js exits 1 both bare and under --best-effort', () => {
  const { script } = installCliFixture('class Client {}\n');

  const bare = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(bare.status, 1, 'production install must fail on an unsupported installed tree');
  assert.match(bare.stderr, /unsupported Client\.js shape/);

  const bestEffort = spawnSync(process.execPath, [script, '--best-effort'], { encoding: 'utf8' });
  assert.equal(
    bestEffort.status,
    1,
    '--best-effort must not hide an unsupported installed whatsapp-web.js tree',
  );
  assert.match(bestEffort.stderr, /unsupported Client\.js shape/);
});

test('CLI: installed package missing Client.js exits 1 even under --best-effort', () => {
  const { root, script } = installCliFixture(undefined);
  fs.mkdirSync(path.join(root, 'node_modules', 'whatsapp-web.js'), { recursive: true });

  const bestEffort = spawnSync(process.execPath, [script, '--best-effort'], { encoding: 'utf8' });

  assert.equal(bestEffort.status, 1);
  assert.match(bestEffort.stderr, /is installed but Client\.js was not found/);
});

test('CLI: a completely absent whatsapp-web.js package is fatal bare but skippable under --best-effort', () => {
  const { script } = installCliFixture(undefined);

  const bare = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /package not found/);

  const bestEffort = spawnSync(process.execPath, [script, '--best-effort'], { encoding: 'utf8' });
  assert.equal(bestEffort.status, 0);
  assert.match(bestEffort.stderr, /skipped/);
  assert.match(bestEffort.stderr, /package not found/);
});

/**
 * Shape assertions on the replacement strings themselves. Runtime reconciliation relies on these
 * properties, so keep them explicit and cheap to diagnose when whatsapp-web.js changes upstream.
 */
test('replacements carry the bridge/readiness contract the adapter relies on', () => {
  assert.ok(FLAG_INIT_REPLACE.includes('this.eventsAttached = false;'), 'flag starts false');

  const resetIndex = ATTACH_MARK_REPLACE.indexOf('this.eventsAttached = false;');
  const attachIndex = ATTACH_MARK_REPLACE.indexOf('await this.attachEventListeners();');
  const readyIndex = ATTACH_MARK_REPLACE.indexOf('this.eventsAttached = true;');

  assert.ok(resetIndex >= 0, 'bridge flag resets before each attach attempt');
  assert.ok(resetIndex < attachIndex, 'bridge flag resets before attach begins');
  assert.ok(attachIndex < readyIndex, 'bridge flag flips true only after attach resolves');

  assert.ok(
    HAS_SYNCED_REPLACE.includes("if (window.require('WAWebSocketModel').Socket.hasSynced)"),
    'hasSynced level guard is present',
  );
  assert.equal(
    HAS_SYNCED_REPLACE.split('window.onAppStateHasSyncedEvent()').length - 1,
    2,
    'the level-check invokes the same handler as the edge listener',
  );
});

