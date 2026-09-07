

/**
 * Make whatsapp-web.js readiness observable and race-free on warm session restores.
 *
 * whatsapp-web.js 1.34.7 runs its entire post-auth pipeline — LoadUtils, ClientInfo,
 * attachEventListeners (the page->Node message bridge), and the `ready` emit — inside a callback
 * fired by the page-side `change:hasSynced` EDGE. Two real failure modes follow:
 *
 * 1. On a warm/persistent profile the page can reach hasSynced=true BEFORE the listener attaches;
 *    the edge never comes again and the whole pipeline silently never runs.
 * 2. attachEventListeners can throw partway; `ready` never fires, while sends may still work, so the
 *    session can look connected even though inbound events are unavailable.
 *
 * Three transforms are applied as ONE all-or-nothing group:
 *  - initialize `eventsAttached = false` on the client;
 *  - set `eventsAttached = true` only AFTER attachEventListeners() resolves;
 *  - after subscribing to `change:hasSynced`, immediately replay the handler when hasSynced is
 *    already true, closing the missed-edge race.
 *
 * Safety contract:
 *  - a completely absent whatsapp-web.js target may be skipped under `--best-effort` (for installs
 *    that do not carry this engine);
 *  - an installed but unsupported / partially patched Client.js is ALWAYS fatal, including under
 *    `--best-effort`. Shipping a half-applied readiness repair is worse than failing installation.
 *  - the target file is written only after every expected source shape has been validated.
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

const CLIENT_PATH = path.join(
  'src',
  'Client.js',
);

const PATCH_ERROR_CODES = Object.freeze({
  TARGET_MISSING: 'READY_SYNC_TARGET_MISSING',
  UNSUPPORTED_SHAPE: 'READY_SYNC_UNSUPPORTED_SHAPE',
});

const FLAG_INIT_FIND = `        this.currentIndexHtml = null;
        this.lastLoggedOut = false;`;

const FLAG_INIT_REPLACE = `        this.currentIndexHtml = null;
        this.lastLoggedOut = false;
        // Set true only after attachEventListeners() resolves; the message bridge is not
        // trustworthy before that, even when the page itself reports CONNECTED.
        this.eventsAttached = false;`;

const ATTACH_MARK_FIND = `                    await this.attachEventListeners();
                }`;

const ATTACH_MARK_REPLACE = `                    await this.attachEventListeners();
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
            // then never fires again. Fire once on the already-reached level as well.
            if (window.require('WAWebSocketModel').Socket.hasSynced) {
                window.onAppStateHasSyncedEvent();
            }`;

const EDITS = [
  {
    find: FLAG_INIT_FIND,
    replace: FLAG_INIT_REPLACE,
  },
  {
    find: ATTACH_MARK_FIND,
    replace: ATTACH_MARK_REPLACE,
  },
  {
    find: HAS_SYNCED_FIND,
    replace: HAS_SYNCED_REPLACE,
  },
];

function occurrences(
  source,
  needle,
) {
  return source
    .split(needle)
    .length - 1;
}

function createPatchError(
  code,
  message,
) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function errorMessage(
  error,
) {
  return error instanceof Error
    ? error.message
    : String(error);
}

/**
 * Count each pristine source fragment after removing the corresponding replacement fragment first.
 *
 * Every replacement intentionally contains its original `find`, so counting raw source alone would
 * report both "patched" and "unpatched" at the same time.
 */
function inspectPatchState(
  source,
) {
  const replaces =
    EDITS.map(
      edit =>
        occurrences(
          source,
          edit.replace,
        ),
    );

  const finds =
    EDITS.map(
      edit =>
        occurrences(
          source
            .split(edit.replace)
            .join(''),
          edit.find,
        ),
    );

  return {
    finds,
    replaces,
  };
}

function isFullyPatched(
  state,
) {
  return (
    state.finds.every(
      count =>
        count === 0,
    ) &&
    state.replaces.every(
      count =>
        count === 1,
    )
  );
}

function isFullyUnpatched(
  state,
) {
  return (
    state.finds.every(
      count =>
        count === 1,
    ) &&
    state.replaces.every(
      count =>
        count === 0,
    )
  );
}

function applyReadySyncPatch(
  wwjsDir = DEFAULT_WWJS,
) {
  const clientFile =
    path.join(
      wwjsDir,
      CLIENT_PATH,
    );

  if (
    !fs.existsSync(
      clientFile,
    )
  ) {
    throw createPatchError(
      PATCH_ERROR_CODES.TARGET_MISSING,
      `whatsapp-web.js Client.js not found at ${clientFile}`,
    );
  }

  const original =
    fs.readFileSync(
      clientFile,
      'utf8',
    );

  const state =
    inspectPatchState(
      original,
    );

  if (
    isFullyPatched(
      state,
    )
  ) {
    return {
      skipped: true,
      reason:
        'installed whatsapp-web.js already carries the ready-sync repair',
    };
  }

  if (
    !isFullyUnpatched(
      state,
    )
  ) {
    throw createPatchError(
      PATCH_ERROR_CODES.UNSUPPORTED_SHAPE,
      `unsupported Client.js shape ` +
        `(unpatched: ${state.finds.join(',')}, patched: ${state.replaces.join(',')}); ` +
        're-evaluate the ready-sync repair against the installed whatsapp-web.js',
    );
  }

  /*
   * Transform entirely in memory first.
   *
   * Nothing is written until the source shape is known to match every expected edit exactly.
   */
  let patched =
    original;

  for (
    const edit
    of EDITS
  ) {
    patched =
      patched.replace(
        edit.find,
        edit.replace,
      );
  }

  /*
   * Defensive verification of the result before touching disk.
   *
   * This should already be guaranteed by isFullyUnpatched(), but retaining this check ensures a
   * future edit to this patcher cannot accidentally write a partially transformed Client.js.
   */
  const finalState =
    inspectPatchState(
      patched,
    );

  if (
    !isFullyPatched(
      finalState,
    )
  ) {
    throw createPatchError(
      PATCH_ERROR_CODES.UNSUPPORTED_SHAPE,
      `ready-sync transform did not produce the expected final shape ` +
        `(unpatched: ${finalState.finds.join(',')}, patched: ${finalState.replaces.join(',')})`,
    );
  }

  fs.writeFileSync(
    clientFile,
    patched,
    'utf8',
  );

  return {
    skipped: false,
    note:
      'readiness marker and hasSynced level-check applied',
  };
}

/**
 * CLI entry point.
 *
 * `--best-effort` means only:
 *
 *   "it is okay if whatsapp-web.js is not installed here"
 *
 * It does NOT mean:
 *
 *   "ignore an unsupported or half-patched Client.js"
 *
 * An installed-but-unsafe tree therefore always returns exit code 1.
 */
function run(
  argv = process.argv,
) {
  const bestEffort =
    argv.includes(
      '--best-effort',
    );

  try {
    const result =
      applyReadySyncPatch();

    console.log(
      `patch-wwebjs-ready-sync: ${
        result.skipped
          ? `skipped — ${result.reason}`
          : result.note
      }`,
    );

    return 0;
  } catch (
    error
  ) {
    const message =
      errorMessage(
        error,
      );

    const code =
      error &&
      typeof error === 'object'
        ? error.code
        : undefined;

    /*
     * Best-effort is allowed ONLY when whatsapp-web.js itself is absent.
     *
     * If Client.js exists but its contents do not match the known pristine or fully-patched form,
     * installation must fail. Otherwise OpenWA could silently run without the readiness guarantees
     * this patch exists to provide.
     */
    if (
      bestEffort &&
      code ===
        PATCH_ERROR_CODES.TARGET_MISSING
    ) {
      console.warn(
        `patch-wwebjs-ready-sync: skipped — ${message}`,
      );

      return 0;
    }

    console.error(
      `patch-wwebjs-ready-sync: ${message}`,
    );

    return 1;
  }
}

if (
  require.main ===
  module
) {
  process.exitCode =
    run();
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

