/**
 * Make whatsapp-web.js readiness observable and race-free on warm session restores.
 *
 * whatsapp-web.js 1.34.7 runs its post-auth pipeline from the page-side `change:hasSynced`
 * handoff. Two failure modes matter to OpenWA:
 *
 * 1. A warm/persistent profile can already have `Socket.hasSynced === true` before the listener is
 *    attached. The edge is then missed and the post-auth pipeline never starts.
 * 2. `attachEventListeners()` can fail or hang after the page is already CONNECTED. Sends may still
 *    work, but inbound events are unavailable, so OpenWA must not publish READY.
 *
 * Three transforms are applied as one all-or-nothing group:
 *  - initialise `eventsAttached = false` on the Client;
 *  - set `eventsAttached = false` immediately before each bridge attach attempt and `true` only
 *    after `attachEventListeners()` resolves;
 *  - after subscribing to `change:hasSynced`, immediately replay the same handler when
 *    `Socket.hasSynced` is already true.
 *
 * Safety contract:
 *  - under `--best-effort`, a completely absent whatsapp-web.js package may be skipped;
 *  - if whatsapp-web.js exists but Client.js is missing, unsupported, or partially patched, the
 *    patch is fatal even under `--best-effort`;
 *  - Client.js is written only after all expected source shapes have been validated in memory.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(
  __dirname,
  '..',
  'node_modules',
  'whatsapp-web.js',
);

const CLIENT_PATH = path.join('src', 'Client.js');

const PATCH_ERROR_CODES = Object.freeze({
  PACKAGE_MISSING: 'READY_SYNC_PACKAGE_MISSING',
  TARGET_MISSING: 'READY_SYNC_TARGET_MISSING',
  UNSUPPORTED_SHAPE: 'READY_SYNC_UNSUPPORTED_SHAPE',
});

const FLAG_INIT_FIND = `        this.currentIndexHtml = null;
        this.lastLoggedOut = false;`;

const FLAG_INIT_REPLACE = `        this.currentIndexHtml = null;
        this.lastLoggedOut = false;
        // False means the current page->Node event bridge has not been proven attached yet.
        this.eventsAttached = false;`;

const ATTACH_MARK_FIND = `                    await this.attachEventListeners();
                }`;

const ATTACH_MARK_REPLACE = `                    // A re-inject after page navigation must invalidate the previous bridge state
                    // before attempting to attach the listeners for the new document.
                    this.eventsAttached = false;
                    await this.attachEventListeners();
                    this.eventsAttached = true;
                }`;

const HAS_SYNCED_FIND = `            window
                .require('WAWebSocketModel')
                .Socket.on('change:hasSynced', () => {
                    window.onAppStateHasSyncedEvent();
                });`;

const HAS_SYNCED_REPLACE = `            window
                .require('WAWebSocketModel')
                .Socket.on('change:hasSynced', () => {
                    window.onAppStateHasSyncedEvent();
                });
            // A warm profile can restore to hasSynced=true before this listener exists; the edge
            // then never fires again. Fire once from the already-reached level as well.
            if (window.require('WAWebSocketModel').Socket.hasSynced) {
                window.onAppStateHasSyncedEvent();
            }`;

const EDITS = [
  { find: FLAG_INIT_FIND, replace: FLAG_INIT_REPLACE },
  { find: ATTACH_MARK_FIND, replace: ATTACH_MARK_REPLACE },
  { find: HAS_SYNCED_FIND, replace: HAS_SYNCED_REPLACE },
];

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

function createPatchError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Count pristine source fragments after first removing their corresponding replacement fragments.
 *
 * Every replacement intentionally contains its original `find`, so counting the raw source would
 * otherwise report both "patched" and "unpatched" at the same time.
 */
function inspectPatchState(source) {
  const replaces = EDITS.map(edit => occurrences(source, edit.replace));
  const finds = EDITS.map(edit => occurrences(source.split(edit.replace).join(''), edit.find));

  return { finds, replaces };
}

function isFullyPatched(state) {
  return state.finds.every(count => count === 0) && state.replaces.every(count => count === 1);
}

function isFullyUnpatched(state) {
  return state.finds.every(count => count === 1) && state.replaces.every(count => count === 0);
}

function applyReadySyncPatch(wwjsDir = DEFAULT_WWJS) {
  if (!fs.existsSync(wwjsDir)) {
    throw createPatchError(
      PATCH_ERROR_CODES.PACKAGE_MISSING,
      `whatsapp-web.js package not found at ${wwjsDir}`,
    );
  }

  const clientFile = path.join(wwjsDir, CLIENT_PATH);

  if (!fs.existsSync(clientFile)) {
    throw createPatchError(
      PATCH_ERROR_CODES.TARGET_MISSING,
      `whatsapp-web.js is installed but Client.js was not found at ${clientFile}`,
    );
  }

  const original = fs.readFileSync(clientFile, 'utf8');
  const state = inspectPatchState(original);

  if (isFullyPatched(state)) {
    return {
      skipped: true,
      reason: 'installed whatsapp-web.js already carries the ready-sync repair',
    };
  }

  if (!isFullyUnpatched(state)) {
    throw createPatchError(
      PATCH_ERROR_CODES.UNSUPPORTED_SHAPE,
      `unsupported Client.js shape ` +
        `(unpatched: ${state.finds.join(',')}, patched: ${state.replaces.join(',')}); ` +
        're-evaluate the ready-sync repair against the installed whatsapp-web.js',
    );
  }

  // Transform entirely in memory. Do not touch disk until all three source shapes were validated.
  let patched = original;
  for (const edit of EDITS) {
    patched = patched.replace(edit.find, edit.replace);
  }

  // Defensive post-transform verification before the single write.
  const finalState = inspectPatchState(patched);
  if (!isFullyPatched(finalState)) {
    throw createPatchError(
      PATCH_ERROR_CODES.UNSUPPORTED_SHAPE,
      `ready-sync transform did not produce the expected final shape ` +
        `(unpatched: ${finalState.finds.join(',')}, patched: ${finalState.replaces.join(',')})`,
    );
  }

  fs.writeFileSync(clientFile, patched, 'utf8');

  return {
    skipped: false,
    note: 'readiness marker, bridge lifecycle marker, and hasSynced level-check applied',
  };
}

/**
 * CLI entry point.
 *
 * `--best-effort` means only that it is acceptable for whatsapp-web.js itself not to be installed.
 * It never permits an installed-but-unsafe dependency tree.
 */
function run(argv = process.argv) {
  const bestEffort = argv.includes('--best-effort');

  try {
    const result = applyReadySyncPatch();

    console.log(
      `patch-wwebjs-ready-sync: ${
        result.skipped ? `skipped — ${result.reason}` : result.note
      }`,
    );

    return 0;
  } catch (error) {
    const message = errorMessage(error);
    const code = error && typeof error === 'object' ? error.code : undefined;

    if (bestEffort && code === PATCH_ERROR_CODES.PACKAGE_MISSING) {
      console.warn(`patch-wwebjs-ready-sync: skipped — ${message}`);
      return 0;
    }

    console.error(`patch-wwebjs-ready-sync: ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = run();
}

module.exports = {
  applyReadySyncPatch,
  run,
  EDITS,
  PATCH_ERROR_CODES,
  FLAG_INIT_FIND,
  FLAG_INIT_REPLACE,
  ATTACH_MARK_FIND,
  ATTACH_MARK_REPLACE,
  HAS_SYNCED_FIND,
  HAS_SYNCED_REPLACE,
};


