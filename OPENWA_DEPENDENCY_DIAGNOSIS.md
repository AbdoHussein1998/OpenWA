# OpenWA 2026-11-17 startup failure: dependency diagnosis, remediation and verification

## Evidence and root cause

The supplied startup output shows `Could not locate the bindings file` while resolving
`backend/node_modules/better-sqlite3/**/better_sqlite3.node`. The search path contains
`compiled/24.21.0/win32/x64`, identifying a Windows x64 process using Node 24.21.0 at the time
of the failure. The repository's Node 22 development toolchain has dependencies whose
lockfile engine requirements include Node **22.22.3+**. It is unsafe to assume that a native
binary installed under another Node.js runtime is usable.

The first connection named **main** is **always** TypeORM `better-sqlite3`, independently of
`DATABASE_TYPE`. The second connection named **data** is `better-sqlite3` by default and
can be configured as PostgreSQL. Both connections fail in the log because the SQLite
native module is not present; this is NOT evidence that the on-disk SQLite files are bad.

On the previous Dockerfile, `npm ci --omit=dev --ignore-scripts` prevented the native build
or prebuild download for `better-sqlite3`. The subsequent source patchers do not build that
module. This is an independently confirmed code defect in the previous Docker runtime
installation recipe; a successful `npm ci` exit did not prove that the runtime binding
was operational. On Windows, the original npm install output was not included in the
uploaded logs, so we cannot prove whether the missing binary was caused by disabled
scripts, an interrupted install, a Node version change, compiler failure, or a failed
prebuilt binary download. The repair and smoke test cover all these routes.

The warning `pre-write chmod ... ENOENT` occurred during normal first-run creation of
`data/.env.generated`: the utility used to call `chmod` on a file before it existed.
That warning is unrelated to the database failure and is corrected separately.

The legacy log sanitizer also redacted every `metadata.context` field because the sensitive
key matcher treats the substring `text` inside `context` as secret material. The fix now
retains *only* tightly bounded Nest-style class names (for example `NestFramework`), while
redacting arbitrary free-form contexts. Full stack traces remain capped at 1,024 characters
by the existing log safety policy; the new native preflight message is concise enough to fit.

The `NODE_ENV is not set` warning is genuine: local development allows permissive CORS,
Swagger, and error detail. Configure `NODE_ENV=production` **with valid production secrets**
on deployed production infrastructure; do not suppress this warning by hardcoding a value
inside the application.

## Dependency and impact levels

| Level | Dependency | Impact | Fix or control |
|---|---|---|---|
| L0 host/ABI | Node 24.21.0 in the log vs the supported Node 22.22.3 runtime, Windows x64 | May not match a previously installed native binary | Use one Node version for install and runtime |
| L1 npm install | npm lifecycle scripts, native prebuild/install toolchain | Can leave `better_sqlite3.node` absent | Reinstall/rebuild with lifecycle scripts; `deps:check` |
| L2 database driver | `better-sqlite3` 12.11.1 (resolved in lockfile) | Native module cannot load | Targeted native smoke query |
| L3 TypeORM connections | `main` SQLite and `data` SQLite (default) | Both startup connections fail and retry | Boot preflight before Nest creates TypeORM providers |
| L4 Nest modules | RBAC, API key auth, audit, sessions, messaging, and other providers | App never finishes bootstrapping | Restore driver; then run boot smoke/health checks |
| L5 deployment image | Docker `--ignore-scripts` native install gap | Docker image may build without a usable runtime driver | Rebuild native driver explicitly; fail Docker build if bad |
| Independent | New secret file chmod ENOENT | Noisy but nonfatal first-run warning | Check existence before chmod; preserve post-write chmod |
| Operational | `NODE_ENV` unset | Insecure development defaults if deployed | Set prod configuration and valid secrets |

## Fixed source paths

- `backend/src/config/native-dependency-preflight.ts` — startup check with actionable error.
- `backend/src/main.ts` — invoke check **before** `NestFactory.create()`.
- `backend/scripts/check-native-deps.js` — independent native module + SQL smoke test.
- `backend/scripts/postinstall.js` — fail npm postinstall if installed native module fails smoke.
- `backend/Dockerfile` — production-stage native rebuild with scripts explicitly enabled,
  then smoke before vendor patchers; temporary compiler toolchain.
- `backend/src/common/utils/secret-file.ts` — avoid first-create false warning.
- `backend/src/common/services/logging/log-sanitizer.ts` — preserve safe logger class context in diagnostic metadata without exposing arbitrary context text.
- `backend/package.json`, lockfiles and all `.nvmrc` files — deterministic install and Node compatibility.
- Adjacent tests, scripts and docs were updated.

## Windows PowerShell: clean verified installation

Run in the full project root, not inside an extracted dependency-only package.
Preserve `backend/data`, `backend/.env`, sessions, databases, and API keys.

```powershell
cd 'D:\SPgroup\Technical\Current\OpenWA'
node -v
npm -v
npm config get ignore-scripts
```

Install and select Node **22.22.3 or later in the Node 22 branch**, using your configured
Node version manager or official installer. **Open a new PowerShell session** after switching,
and verify `node -v` again. If `ignore-scripts` is `true`, remove the setting in npm config or
explicitly override it with `--ignore-scripts=false` during install.

```powershell
npm --prefix backend ci --include=dev --ignore-scripts=false
npm --prefix backend run deps:check
npm --prefix backend run build
npm --prefix frontend ci --include=dev
npm --prefix frontend run build
npm run dev
```

`npm ci` removes and recreates **node_modules only**, using the lockfile; this is safe for
application data but redoes any dependency patching. The backend's postinstall must run so
its required WhatsApp library patchers are applied. If an otherwise completed install lacks
the native driver, repair it without reinstalling all packages:

```powershell
npm --prefix backend rebuild better-sqlite3 --foreground-scripts --ignore-scripts=false
npm --prefix backend run deps:check
```

If compilation is required, install the Visual Studio Build Tools workload containing
**Desktop development with C++** and a supported Python installation for node-gyp,
then repeat the `npm ci` command. Do not copy a Linux or Node 24 `.node` file into the
Windows Node 22 installation; `.node` files are platform/ABI specific.

## Production Docker (after updating the source)

```powershell
docker compose build --no-cache al-hakim-api
docker compose up -d al-hakim-api
docker compose logs --tail 120 al-hakim-api
docker compose ps
```

The service names are configured in `docker-compose.yml`; check their actual names before
using these commands. Do **not** use `docker compose down -v` (it removes persistent volumes).
The Dockerfile now uses `npm ci --omit=dev --ignore-scripts` followed by
`npm rebuild better-sqlite3 --foreground-scripts --ignore-scripts=false` and
`node scripts/check-native-deps.js` before the WA engine patchers. A missing driver makes
the image build fail instead of shipping a broken image.

## Validation commands and expected outcomes

```powershell
npm --prefix backend run deps:check         # prints native driver OK and exits 0
npm --prefix backend run build             # compiles NestJS/TypeScript
npm --prefix backend run test:native       # isolated native diagnostic tests
npm --prefix backend run test:scripts      # integration patch scripts (requires node_modules)
npm --prefix backend test -- --runInBand    # backend Jest tests
npm --prefix frontend run build
```

After a successful boot, expect both TypeORM connections to initialize without native
binding errors, followed by a healthy response at
`http://127.0.0.1:2785/api/health/ready` for the local configuration.
A subsequent database migration error (if any) should be diagnosed separately.

## Validation performed on the supplied ZIP in the isolated analysis environment

The archive contained **no node_modules**, and the environment lacks a reachable npm
registry, the pinned Node 22.22.3 runtime, and a Docker daemon. Accordingly a true
native binding test, full NestJS/React compile, Docker image build or database boot cannot
be confirmed here. Dependency-free Node tests and Dockerfile/static checks are runnable;
results are recorded in `TEST_RESULTS.md`. The downloaded ZIP contains source and test
changes, not precompiled platform-specific native binaries.
