#!/usr/bin/env node
'use strict';

/**
 * Verify the package's compiled .node binding, not merely that require.resolve() finds JS files.
 * Kept dependency-free so it can run after npm ci and in the production image before patching.
 */
function checkNativeBinding(load = () => require('better-sqlite3')) {
  let db;
  let result;
  try {
    const Sqlite = load();
    db = new Sqlite(':memory:');
    if (db.prepare('SELECT 1 AS healthy').get()?.healthy !== 1) {
      throw new Error('SQLite smoke query returned an unexpected result');
    }
    result = { ok: true };
  } catch (error) {
    result = { ok: false, reason: error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : String(error) };
  }
  if (db) {
    try {
      db.close();
    } catch (error) {
      return { ok: false, reason: `SQLite native connection could not close: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return result;
}

function run(load) {
  const result = checkNativeBinding(load);
  if (result.ok) {
    console.log(`[OpenWA] better-sqlite3 native driver OK (${process.version}, ${process.platform}/${process.arch}).`);
    return 0;
  }
  console.error(
    `[OpenWA] better-sqlite3 NATIVE DRIVER FAILED (${process.version}, ${process.platform}/${process.arch}).\n` +
      `Cause: ${result.reason}\n` +
      'Use Node 22.22.3+ (repository .nvmrc) consistently for install and run.\n' +
      'From the repository root, run:\n' +
      '  npm config get ignore-scripts\n' +
      '  npm --prefix backend rebuild better-sqlite3 --foreground-scripts --ignore-scripts=false\n' +
      '  npm --prefix backend run deps:check\n' +
      'If rebuild fails, install the Windows C++ build tools/Python (or Linux build toolchain), ' +
      'then retry npm --prefix backend ci --include=dev.\n' +
      'Do not delete data/*.sqlite, session files or configuration to fix this error.',
  );
  return 1;
}

if (require.main === module) process.exitCode = run();

module.exports = { checkNativeBinding, run };
