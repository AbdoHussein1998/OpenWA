# Three-container architecture changes

Based on the previous `al-hakim-separated-frontend-backend.zip` source snapshot.

## Reorganization

- Existing NestJS source, scripts, tests, dependency manifests, SDKs, docs, and Docker image moved to `backend/`.
- Existing React/Vite dashboard and its dependency manifests moved to `frontend/`.
- Nginx reverse proxy moved to `nginxconfig/nginx.conf`, built into its own `al-hakim-nginx` image.
- Root `docker-compose.yml` and `docker-compose.dev.yml` define independent API, frontend, and Nginx application containers.
- Root `package.json` with `dev.mjs` starts NestJS watch and Vite HMR from one `npm run dev`; `npm run setup` installs each app's dependencies.

## Separation of responsibilities

- `backend/Dockerfile` builds and runs NestJS/Brave; no frontend source copied.
- `frontend/Dockerfile` compiles React/Vite. A Node built-in static server serves only generated `dist/` assets on port 4173; no Nginx process or backend source in this image.
- `nginxconfig/Dockerfile` runs the edge Nginx server on port 80; it forwards root SPA navigations to the frontend, `/api`, `/socket.io`, `/mcp` to NestJS and injects a per-request CSP nonce into HTML.
- Only Nginx publishes the dashboard's port 2886. The backend's port 2785 remains loopback-bound for maintenance. Frontend port 4173 is internal only.
- The frontend and edge Nginx containers cannot reach the Docker socket-proxy's internal network.
- Production volume names and the development `./data:/app/data` bind mount are retained.

## Validation performed

- Both Compose files parse, expose expected service build contexts and mount existing files.
- Local Nginx + Node frontend + mock backend: SPA fallback, missing asset 404, `/api`, Socket.IO and MCP proxy routing, CSP nonce injection all passed.
- TypeScript and TSX syntax: 1,090 files, no parsing errors.
- Root `npm ci --offline`, root dev command argument forwarding, backend Docker ignore guard all passed.

## Not performed

- Complete NestJS build, React build, Jest tests, or Docker image build: dependencies and Docker daemon are not present in this environment.
- Helm chart deployment topology change: existing chart retained under `backend/charts/`.

## Deployment precautions

- Back up persistent data before replacing an existing stack; do not use `docker compose down -v`.
- Existing Nginx dashboard container is replaced by a new `al-hakim-nginx` service; update any monitoring or upstream container targets.
- Keep `VITE_API_URL` and `VITE_WS_URL` unset for same-origin requests through Nginx.
- On production releases, set `APP_VERSION` to the backend's release version in root `.env` before `docker compose build` if the dashboard version label must be pinned.

## Native-dependency startup diagnostics and deployment fix (2026-11-17)

- The production backend image now explicitly rebuilds and smoke-tests `better-sqlite3` after its script-suppressed install. The temporary compiler toolchain is removed afterwards.
- Backend postinstall checks the native SQLite binding once the package exists. An independent `npm run deps:check` is available for Windows and CI.
- NestJS bootstrap checks the native SQLite binding before TypeORM creates both connections; missing binaries generate a targeted fatal diagnosis instead of misleading database retries.
- First-time `.env.generated` creation no longer prints an expected ENOENT `chmod` warning.
- Diagnostic metadata now retains safe Nest logger context names instead of incorrectly redacting every context due to a substring match; unsafe context strings stay redacted.
- Node 22.22.3 is the pinned/recommended developer runtime; lockfiles and package engine declarations now agree. Root setup uses reproducible `npm ci`.
- Regression coverage: driver success/failure, Docker install order, postinstall failure propagation, and first-run secret-file permissions.
- No SQLite schemas, migrations, engine behavior, RBAC, dashboard API, or persistent data were changed.

## Windows npm install / whatsapp-web.js 1.34.8 ready-sync repair (2026-11-17)

- Replaced brittle 1.34.8 three-line `Client.js` substring matching with anchored, layout-tolerant source inspection. Whitespace, CRLF and comment-only layout differences no longer prevent the ready-sync bridge patch.
- Preserved the native atomic `hasSynced` check, the constructor and listener attachment state flags, idempotency, and fail-closed rejection of unexpected/partially patched upstream code.
- Added six source-shape regression tests and one CLI `--best-effort` integration test to `backend/scripts/patch-wwebjs-ready-sync.spec.js`.
- See `READY_SYNC_INSTALL_FIX_2026-11-17.md` and `READY_SYNC_TEST_RESULTS.md` for the repair rationale, installation instructions, and limitations.
