/**
 * Make whatsapp-web.js readiness observable and race-free on warm session restores.
 *
 * Supports the original whatsapp-web.js 1.34.7 handoff and the revised 1.34.8
 * listener registration. The 1.34.8 release already includes the atomic `Socket.hasSynced`
 * level-check, so it must NOT be injected again. Two failure modes matter to OpenWA:
 *
 * 1. A warm/persistent profile can already have `Socket.hasSynced === true` before the listener is
 *    attached. The edge is then missed and the post-auth pipeline never starts.
 * 2. `attachEventListeners()` can fail or hang after the page is already CONNECTED. Sends may still
 *    work, but inbound events are unavailable, so OpenWA must not publish READY.
 *
 * For the legacy 1.34.7 shape, three transforms are applied as one atomic group. For the
 * 1.34.8 shape, two transforms are applied and the native atomic hasSynced check is retained:
 *  - initialise `eventsAttached = false` on the Client;
 *  - set `eventsAttached = false` immediately before each bridge attach attempt and `true` only
 *    after `attachEventListeners()` resolves;
 *  - legacy only: replay the handler when Socket.hasSynced is already true.
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

/**
 * whatsapp-web.js 1.34.8 changed Client.js indentation and replaced the old direct
 * change:hasSynced subscription with a listener registry and an atomic level-check.
 * Keep the native level-check intact; only insert the adapter's bridge marker.
 *
 * Runtime matching anchors to the unique InterfaceController assignment and awaited listener
 * attachment, tolerating indentation, CRLF and comment-only gaps (but no executable drift).
 */
const MODERN_ATTACH_MARK_FIND = `                        this.interface = new InterfaceController(this);
                        await this.attachEventListeners();
                    }`;

const MODERN_ATTACH_MARK_REPLACE = `                        this.interface = new InterfaceController(this);
                        // OpenWA: a bridge is usable only when all its listeners have attached.
                        this.eventsAttached = false;
                        await this.attachEventListeners();
                        this.eventsAttached = true;
                    }`;

const MODERN_SYNC_SIGNATURES = [
  `                const listeners = [`,
  `                        'change:hasSynced',`,
  `                window._wwjsListeners = listeners;`,
  `                const storeInjected = typeof window.WWebJS !== 'undefined';`,
  `                if (Socket.hasSynced === true && !storeInjected) {`,
];

const MODERN_EDITS = [
  { find: FLAG_INIT_FIND, replace: FLAG_INIT_REPLACE },
  { find: MODERN_ATTACH_MARK_FIND, replace: MODERN_ATTACH_MARK_REPLACE },
];

/** Fail closed on unfamiliar or partly changed upstream listener plumbing. */
function hasModernSyncContract(source) {
  return MODERN_SYNC_SIGNATURES.every(signature => occurrences(source, signature) === 1);
}

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
function inspectPatchState(source, edits = EDITS) {
  const replaces = edits.map(edit => occurrences(source, edit.replace));
  const finds = edits.map(edit => occurrences(source.split(edit.replace).join(''), edit.find));

  return { finds, replaces };
}

function isFullyPatched(state) {
  return state.finds.every(count => count === 0) && state.replaces.every(count => count === 1);
}

function isFullyUnpatched(state) {
  return state.finds.every(count => count === 1) && state.replaces.every(count => count === 0);
}

/**
 * Inspect the modern bridge attachment without relying on its indentation or closing brace.
 * npm-distributed Client.js can differ slightly in layout from the documented upstream source,
 * and Windows checkouts can have CRLF line endings. Neither variation changes the code contract.
 *
 * Still fail closed: there must be exactly one InterfaceController assignment and one awaited
 * listener attach; only whitespace/comments may occur between them in the pristine version.
 * For the patched version, the exact OpenWA marker must surround that call.
 */
function inspectModernAttach(source) {
  const interfaceMatches = [
    ...source.matchAll(/^[ \t]*this\.interface = new InterfaceController\(this\);[ \t]*$/gm),
  ];
  const attachMatches = [
    ...source.matchAll(/^([ \t]*)await this\.attachEventListeners\(\);[ \t]*$/gm),
  ];

  if (interfaceMatches.length !== 1 || attachMatches.length !== 1) {
    return { kind: 'unsupported', detail: `interface=${interfaceMatches.length}, attach=${attachMatches.length}` };
  }

  const anchor = interfaceMatches[0];
  const call = attachMatches[0];
  const gap = source.slice(anchor.index + anchor[0].length, call.index);

  // A small, unbroken sequence of comments/whitespace after InterfaceController is safe.
  // A new statement/branch between these lines changes the lifecycle; reject it.
  const lines = gap.split('\n').map(line => line.trim()).filter(Boolean);
  const pristine = call.index > anchor.index && gap.length < 1600 &&
    lines.every(line => line.startsWith('//'));

  const patchedBefore = lines.length >= 2 &&
    lines.at(-2) === '// OpenWA: a bridge is usable only when all its listeners have attached.' &&
    lines.at(-1) === 'this.eventsAttached = false;' &&
    lines.slice(0, -2).every(line => line.startsWith('//'));
  const patchedAfter = /^\n[ \t]*this\.eventsAttached = true;[ \t]*(?:\n|$)/.test(
    source.slice(call.index + call[0].length),
  );

  if (call.index <= anchor.index || gap.length >= 1600) {
    return { kind: 'unsupported', detail: 'bridge anchor is outside the expected callback' };
  }

  if (pristine && !patchedAfter) {
    return { kind: 'pristine', call, detail: 'single unmodified attachment call' };
  }
  if (patchedBefore && patchedAfter) {
    return { kind: 'patched', call, detail: 'existing OpenWA bridge marker' };
  }
  return { kind: 'unsupported', detail: 'unexpected statements or partial bridge marker' };
}

function patchModernClient(original) {
  // Do not silently rewrite a mixed-line-ending dependency file.
  const hasCrLf = original.includes('\r\n');
  if (hasCrLf && /(^|[^\r])\n/.test(original)) {
    throw createPatchError(PATCH_ERROR_CODES.UNSUPPORTED_SHAPE, 'mixed Client.js line endings');
  }
  const source = original.replace(/\r\n/g, '\n');
  const flagState = inspectPatchState(source, [MODERN_EDITS[0]]);
  const flagPristine = isFullyUnpatched(flagState);
  const flagPatched = isFullyPatched(flagState);
  const bridge = inspectModernAttach(source);
  const flags = `constructor: ${flagPatched ? 'patched' : flagPristine ? 'pristine' : 'unknown'}, ` +
    `bridge: ${bridge.kind} (${bridge.detail})`;

  if (flagPatched && bridge.kind === 'patched') {
    return { skipped: true, reason: 'installed whatsapp-web.js already carries the ready-sync repair' };
  }
  if (!flagPristine || bridge.kind !== 'pristine') {
    throw createPatchError(
      PATCH_ERROR_CODES.UNSUPPORTED_SHAPE,
      `unsupported Client.js shape (variant: 1.34.8, ${flags}); ` +
        're-evaluate the ready-sync repair against the installed whatsapp-web.js',
    );
  }

  const call = bridge.call;
  const indent = call[1];
  const replacement = [
    `${indent}// OpenWA: a bridge is usable only when all its listeners have attached.`,
    `${indent}this.eventsAttached = false;`,
    `${indent}await this.attachEventListeners();`,
    `${indent}this.eventsAttached = true;`,
  ].join('\n');

  // Work entirely in memory and revalidate both edits before any filesystem write.
  let patched = source.replace(FLAG_INIT_FIND, FLAG_INIT_REPLACE);
  // Re-inspect after constructor insertion, as it shifts the attach position.
  const attach = inspectModernAttach(patched);
  if (attach.kind !== 'pristine') {
    throw createPatchError(PATCH_ERROR_CODES.UNSUPPORTED_SHAPE, 'bridge changed during ready-sync transform');
  }
  patched = patched.slice(0, attach.call.index) + replacement +
    patched.slice(attach.call.index + attach.call[0].length);

  if (!isFullyPatched(inspectPatchState(patched, [MODERN_EDITS[0]])) ||
      inspectModernAttach(patched).kind !== 'patched' || !hasModernSyncContract(patched)) {
    throw createPatchError(
      PATCH_ERROR_CODES.UNSUPPORTED_SHAPE,
      'ready-sync transform did not produce the expected 1.34.8 bridge contract',
    );
  }

  return {
    skipped: false,
    content: hasCrLf ? patched.replace(/\n/g, '\r\n') : patched,
    note: '1.34.8: bridge readiness marker applied; native atomic hasSynced check retained',
  };
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
  const modern = hasModernSyncContract(original);

  if (modern) {
    const result = patchModernClient(original);
    if (!result.skipped) fs.writeFileSync(clientFile, result.content, 'utf8');
    return { skipped: result.skipped, reason: result.reason, note: result.note };
  }

  // Legacy 1.34.7 remains intentionally exact: no transformation is allowed unless all three
  // original forms are present exactly once. Do not infer that an unknown release is legacy.
  const state = inspectPatchState(original, EDITS);
  if (isFullyPatched(state)) {
    return { skipped: true, reason: 'installed whatsapp-web.js already carries the ready-sync repair' };
  }
  if (!isFullyUnpatched(state)) {
    throw createPatchError(
      PATCH_ERROR_CODES.UNSUPPORTED_SHAPE,
      `unsupported Client.js shape ` +
        `(variant: legacy-or-unknown, unpatched: ${state.finds.join(',')}, ` +
        `patched: ${state.replaces.join(',')}); ` +
        're-evaluate the ready-sync repair against the installed whatsapp-web.js',
    );
  }

  let patched = original;
  for (const edit of EDITS) {
    patched = patched.replace(edit.find, edit.replace);
  }
  if (!isFullyPatched(inspectPatchState(patched, EDITS))) {
    throw createPatchError(
      PATCH_ERROR_CODES.UNSUPPORTED_SHAPE,
      'ready-sync transform did not produce the expected legacy contract',
    );
  }
  fs.writeFileSync(clientFile, patched, 'utf8');
  return { skipped: false, note: 'legacy: readiness marker, bridge lifecycle marker, and hasSynced level-check applied' };
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
  MODERN_ATTACH_MARK_FIND,
  MODERN_ATTACH_MARK_REPLACE,
  MODERN_SYNC_SIGNATURES,
  hasModernSyncContract,
  inspectModernAttach,
  patchModernClient,
};


