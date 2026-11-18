# OpenWA Dependency and Node.js Configuration Files

This bundle contains **unchanged copies** of dependency and runtime files taken from the uploaded `OpenWA.zip`.
It is **not the complete application**. Copy these files into the **same paths** inside your existing OpenWA project, or inspect them individually. It does not contain `node_modules`, the Node.js executable, application source code, or external system dependencies such as databases.

## Included files

### Root (Node.js and installation orchestration)
- `.nvmrc`: Node.js 22.22.3 (exact minimum compatible version of the Node 22 line).
- `package.json` / `package-lock.json`: root scripts and lockfile. The root postinstall runs nested `npm install` commands for both apps.
- `dev.mjs`: used by the root `npm run dev` script.

### Backend (NestJS)
- `backend/package.json` / `backend/package-lock.json`: direct and transitive dependency versions.
- `backend/.nvmrc`: Node.js 22.22.3.
- `backend/scripts/postinstall.js`: post-install patch orchestrator.
- `backend/scripts/patch-*.js`: eight required conditional patch scripts for whatsapp-web.js and Baileys. Keep these scripts in their original locations during installation.
- `backend/Dockerfile`: Node.js container build and production dependency installation.

### Frontend (React/Vite)
- `frontend/package.json` / `frontend/package-lock.json`: direct and transitive dependencies.
- `frontend/.npmrc`: configures `legacy-peer-deps=true`; keep it alongside the lockfile.
- `frontend/Dockerfile`: Node.js container build.

### Optional JavaScript SDK
- `backend/sdk/javascript/package.json` / `backend/sdk/javascript/package-lock.json`: standalone SDK development dependencies.

## Node.js version

Both `.nvmrc` files now contain `22.22.3`. The resolved backend dependencies include `@angular-devkit/core`, `@angular-devkit/schematics` and the nested `@nestjs/schematics` requiring Node.js **22.22.3 or later** on the Node 22 branch. The frontend's `jsdom` requires at least 22.22.2. Use an installed compatible Node.js 22 release >=22.22.3, and check with `node -v`.

## Windows PowerShell — commands in the full project root

```powershell
node -v
npm -v
npm --prefix backend ci --include=dev --ignore-scripts=false
npm --prefix backend run deps:check
npm --prefix frontend ci --include=dev
npm --prefix backend run build
npm --prefix frontend run build
npm run dev
```

The root `package.json` runs lockfile-reproducible `npm ci` for both apps from `postinstall`. To avoid this behavior, use the explicit `npm --prefix` commands above. Do not run the backend install without its postinstall/patch scripts: its installed WhatsApp libraries are customized.

Optional SDK development:

```powershell
npm --prefix backend/sdk/javascript ci
npm --prefix backend/sdk/javascript run build
```

## Notes

- Files are identical to the archive, not upgraded or repaired.
- Run npm commands only in the **full project** (containing source files), not this dependency-only bundle.
- `npm ci` uses each existing lockfile rather than updating resolved versions.
- Backend production Docker installation uses `--ignore-scripts` followed by an explicit native `better-sqlite3` rebuild and SQL smoke check before applying required WhatsApp patchers. This is guarded by `scripts/dockerfile-native-deps.spec.js`.
- If Windows startup fails with `SQLITE_NATIVE_DRIVER_UNAVAILABLE`, use the repair/runbook in `OPENWA_DEPENDENCY_DIAGNOSIS.md`. The source ZIP does not contain `node_modules`; native binaries must be built/installed on the destination platform.
