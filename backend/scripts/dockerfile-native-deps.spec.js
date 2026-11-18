const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');

test('Docker build and production image both include the binding verifier', () => {
  const references = dockerfile.match(/scripts\/check-native-deps\.js/g) || [];
  assert.ok(references.length >= 3, 'must COPY into builder and production, and execute in production');
});

test('production install explicitly rebuilds the better-sqlite3 native binding after ignoring lifecycle scripts', () => {
  const install = dockerfile.indexOf('npm ci --omit=dev --ignore-scripts');
  const rebuild = dockerfile.indexOf('npm rebuild better-sqlite3 --foreground-scripts --ignore-scripts=false');
  const check = dockerfile.indexOf('node scripts/check-native-deps.js');
  const patches = dockerfile.indexOf('node scripts/patch-wwebjs-201832.js');
  assert.ok(install >= 0 && install < rebuild);
  assert.ok(rebuild < check && check < patches);
  assert.match(dockerfile, /apt-get install -y --no-install-recommends python3 make g\+\+/);
});
