# OpenWA dependency/startup remediation — validation results

Date: 2026-11-17. Source: uploaded `OpenWA.zip` and 2026-11-17 Windows startup log.

## What was verified

| Test | Result | Evidence |
|---|---|---|
| New and existing targeted Node script tests | **PASS: 32/32** | `node --test scripts/check-native-deps.spec.js scripts/dockerfile-native-deps.spec.js scripts/postinstall.spec.js scripts/dockerfile-patchers.spec.js` |
| Standalone native-dependency diagnostic unit tests | **PASS: 5/5** | `npm run test:native` (native module is mocked) |
| Dependency verification on an intentionally missing installation | **PASS: correct failure detected** | `node scripts/check-native-deps.js` fails nonzero with a repair message; this environment has no `node_modules` |
| TypeScript startup preflight, fake success and missing-module inputs | **PASS** | Direct Node 22 `--experimental-strip-types` invocation, using an injected driver |
| First-run secret write + overwriting loose permissions | **PASS** | Direct Node 22 `--experimental-strip-types` test of `secret-file.ts`, including chmod mode checks |
| Logger sanitizer: safe class context retained; secret context redacted | **PASS** | Direct Node 22 `--experimental-strip-types` invocation |
| TypeScript modified source parsing | **PASS** | TypeScript 5.8 parser against changed `.ts` files (syntax only) |
| Docker context secrets exclusion | **PASS** | `npm run check:dockerignore` — 29 blocked and 18 allowed paths asserted |
| JavaScript syntax of native checker and postinstall | **PASS** | `node --check` |
| Manifest/lockfile parity for Node engine metadata | **PASS** | JSON verified: backend, frontend, root `^22.22.3` |
| Whole existing scripts suite | **118/131 pass; 13 fail** | Baseline before edits **110/123 pass; 13 fail**. The same 13 tests read missing `node_modules/whatsapp-web.js` and `node_modules/@whiskeysockets/baileys` files |
| Other existing repository checks | **Existing failures** | `check:versions` has 5 historical release-document mismatches (CHANGELOG, SECURITY and chart appVersion); `check:contract-shapes` has 76 SDK contract mismatches or missing types. Not caused by this native-install fix |

## What could not be verified here

The supplied source ZIP does not include `node_modules`. The isolated test host has Node **22.16.0**, not the requested Node **22.22.3+**; npm registry access is unavailable; and Docker is not installed. Therefore **a real better-sqlite3 native binary test, `npm ci`, complete backend/frontend builds, Jest integration tests, Docker build and real NestJS database bootstrap were not performed**. Do not treat these as passing until executed in the target Windows or Docker environment.

Native binaries must be built **on the target operating system and Node version**. The package deliberately includes source, lockfiles, tests, Docker recipe and deployment instructions, but not `node_modules`, secret configs or application data.

## Verification to run on the Windows host

```powershell
cd 'D:\SPgroup\Technical\Current\OpenWA'
node -v  # expected v22.22.3 or a later v22.x
npm --prefix backend ci --include=dev --ignore-scripts=false
npm --prefix backend run deps:check
npm --prefix backend run build
npm --prefix backend run test:native
npm --prefix backend run test:scripts
npm --prefix backend test -- --runInBand
npm --prefix frontend ci --include=dev
npm --prefix frontend run build
```

Then run the app and check that the native driver no longer produces repeated database connection errors. The `NODE_ENV` production security posture still requires a valid production configuration before deployment.
