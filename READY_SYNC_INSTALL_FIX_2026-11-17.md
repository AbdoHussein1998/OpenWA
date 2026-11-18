# OpenWA: whatsapp-web.js ready-sync postinstall failure (2026-11-17)

## Reproduced failure from the Windows log

Root `npm install` invokes `npm run setup`, which runs `npm --prefix backend ci --include=dev` and then frontend CI. The backend postinstall applies several required patches to the installed `whatsapp-web.js` package. With lockfile `whatsapp-web.js` **1.34.8**, `patch-wwebjs-ready-sync.js` rejects `src/Client.js`:

```text
patch-wwebjs-ready-sync: unsupported Client.js shape
(variant: 1.34.8, unpatched: 1,0, patched: 0,0)
```

The constructor marker was recognized (`1`), but the *single literal multiline string* for the bridge attachment was not (`0`). That matcher required precisely the same indentation and closing-brace layout as the fixture; it was too brittle for independently formatted npm-installed sources. The command then returned exit code 1, and backend and root npm postinstall chains correctly aborted. The upstream 1.34.8 source already contains an atomic `Socket.hasSynced` check, which must not be added again.

**Separate issue:** The log uses Node.js 24.21.0, whereas this repository declares `engines.node: ^22.22.3`. `EBADENGINE` is a warning rather than the direct patch failure, but this unsupported runtime should be corrected as well. The deprecated transitive dependency warnings (`glob`, `inflight`, `fluent-ffmpeg`, etc.) are not the immediate install abort.

## Source fix

`backend/scripts/patch-wwebjs-ready-sync.js`

- Detect the released 1.34.8 readiness signatures before modifying anything.
- Locate **exactly one** `InterfaceController` assignment and **exactly one** awaited `attachEventListeners()` call without depending on surrounding whitespace or the precise closing brace.
- Accept whitespace, comments, consistent LF or CRLF line endings, but reject new executable operations between these two anchors, unsupported native sync guard changes, or partial/double patches.
- Add `eventsAttached = false` during Client construction; reset to `false` before listener attachment; change to `true` **only after** `attachEventListeners()` resolves.
- Preserve the upstream atomic `Socket.hasSynced` safeguard; never insert the legacy duplicate on 1.34.8.
- Validate all replacements in memory and write `Client.js` once, only if the final patch contract is satisfied.
- Preserve idempotency: a second postinstall should not edit the package again.

**Limitation:** The user's actual Windows `node_modules/whatsapp-web.js/src/Client.js` was not provided. The published upstream file was checked and dedicated test fixtures cover the previously brittle matching cases; the live Windows package and full runtime could not be executed in this Linux container without npm dependency downloads. If the new patch still rejects `Client.js`, it now provides a more specific diagnosis rather than shipping an unverified listener patch. In that case, compare the local `Client.js` around `this.interface = new InterfaceController(this)` and `await this.attachEventListeners()`; there may be executable changes that should not be patched automatically.

## Tests

- Ready-sync: **22/22 passed**, including CLI install under `--best-effort`, CRLF, altered indentation and extra comments, repeated calls, malicious/unsupported executable drift, partial marker detection, atomic writes, and idempotency.
- Install-related native binding/postinstall/Dockerfile/ready-sync: **49/49 passed** before adding the final CLI regression (final total **50/50**; see `READY_SYNC_TEST_RESULTS.md`).
- Complete `test:scripts` suite run before the final CLI regression: **125 passed / 13 failed / 138 total**. The same 13 tests also failed in the uploaded project's baseline, because they require actual installed upstream packages that were absent here. The ready-sync test changes introduced no new failures.
- Not verified: actual Windows npm CI, Windows native bindings, NestJS production boot, frontend compilation, and live WhatsApp session ready/receive behavior.

## Windows PowerShell: how to apply

After backing up existing `data`, `.env`, and persistent sessions, replace the project source with the updated archive, preserving the existing runtime data. If you prefer a surgical fix, replace only `backend/scripts/patch-wwebjs-ready-sync.js` with the included individual source file.

```powershell
# Use a supported Node 22 release >= 22.22.3
node -v
npm -v

# Run from D:\SPgroup\Technical\Current\OpenWA
npm install
npm --prefix backend run deps:check
npm --prefix backend run build
npm --prefix frontend run build
```

The root postinstall will run backend and frontend `npm ci`. Do not use `--ignore-scripts` for the local Windows installation; backend patchers and the SQLite native binding need lifecycle scripts. Run a normal npm installation under a compatible Node 22 release to avoid the `EBADENGINE` warnings and native ABI problems.

If the installer reports **another patcher** as failing, capture that patcher's exact `unsupported shape` message; do not bypass fail-closed postinstall checks or manually mark the install complete. If `better-sqlite3` fails the subsequent native check, use the separate `OPENWA_DEPENDENCY_DIAGNOSIS.md` repair procedure.
