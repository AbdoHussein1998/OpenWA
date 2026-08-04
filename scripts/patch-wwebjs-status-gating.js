/**
 * Stop whatsapp-web.js from crashing on every status post when WhatsApp Web drops the status
 * ranking-gating helper.
 *
 * whatsapp-web.js 1.34.7 builds the status message with
 * `window.require('WAWebStatusGatingUtils').canCheckStatusRankingPosterGating()` and uses the result
 * as `cannotBeRanked`. That helper is gone from current WhatsApp Web builds, so the call throws
 * `TypeError: window.require(...).canCheckStatusRankingPosterGating is not a function` before the
 * message is ever sent — and because the field is built inline for every status, it takes down
 * text, image, video and voice status alike. Verified on a live account: all four fail identically,
 * on stock 1.34.7, with none of this project's code involved.
 *
 * The replacement calls the helper when it is there and falls back to `false` when it is not, which
 * is what `cannotBeRanked` meant before WhatsApp introduced the gating check. That keeps current
 * behaviour intact wherever the API still exists rather than assuming it is gone everywhere.
 *
 * The source transform is deliberately exact and self-disabling: an unknown shape fails the build
 * instead of silently shipping without the fix, matching the sibling patchers.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const UTILS_PATH = path.join('src', 'util', 'Injected', 'Utils.js');

const UNGUARDED_CALL = `                    cannotBeRanked: window
                        .require('WAWebStatusGatingUtils')
                        .canCheckStatusRankingPosterGating(),`;

const GUARDED_CALL = `                    cannotBeRanked: (() => {
                        // WAWebStatusGatingUtils.canCheckStatusRankingPosterGating is absent from
                        // current WhatsApp Web builds; calling it unguarded threw before the status
                        // was sent, breaking every status type. false is the pre-gating meaning.
                        try {
                            const gating = window.require('WAWebStatusGatingUtils');
                            return typeof gating?.canCheckStatusRankingPosterGating === 'function'
                                ? gating.canCheckStatusRankingPosterGating()
                                : false;
                        } catch {
                            return false;
                        }
                    })(),`;

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

function applyGatingGuard(wwjsDir = DEFAULT_WWJS) {
  const utilsFile = path.join(wwjsDir, UTILS_PATH);
  if (!fs.existsSync(utilsFile)) {
    throw new Error(`whatsapp-web.js Utils.js not found at ${utilsFile}`);
  }

  const source = fs.readFileSync(utilsFile, 'utf8');
  const unguarded = occurrences(source, UNGUARDED_CALL);
  const guarded = occurrences(source, GUARDED_CALL);

  if (unguarded === 0 && guarded === 1) {
    return { skipped: true, reason: 'installed whatsapp-web.js already guards the status gating call' };
  }
  if (unguarded !== 1 || guarded !== 0) {
    throw new Error(
      `unsupported Utils.js shape (unguarded calls: ${unguarded}, guarded calls: ${guarded}); ` +
        're-evaluate the status gating guard against the installed whatsapp-web.js',
    );
  }

  fs.writeFileSync(utilsFile, source.replace(UNGUARDED_CALL, GUARDED_CALL));
  return { skipped: false, note: 'status ranking-gating call guarded against a missing helper' };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyGatingGuard();
    console.log(`patch-wwebjs-status-gating: ${result.skipped ? `skipped — ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-status-gating: skipped — ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-status-gating: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyGatingGuard, UNGUARDED_CALL, GUARDED_CALL };
