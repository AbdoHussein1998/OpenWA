# Al-Hakim — three independent application containers

## Repository layout

```text
al-hakim/
├── backend/              NestJS API, WhatsApp engines, services, migrations and SDKs
│   ├── src/
│   ├── Dockerfile
│   ├── package.json
│   └── .env.example
├── frontend/             React + Vite dashboard, dedicated Node static asset server
│   ├── src/
│   ├── Dockerfile
│   ├── server.mjs
│   └── package.json
├── nginxconfig/          Nginx is its OWN container and reverse proxy
│   ├── Dockerfile
│   └── nginx.conf
├── docker-compose.yml    Production-oriented orchestration (3 core app containers)
├── docker-compose.dev.yml  Container-based SQLite smoke setup (also 3 containers)
├── package.json          Root scripts, including npm run dev
└── .env.example          Compose environment template
```

## Local development — no Docker required for the application servers

Prerequisite: Node.js 22.22.3 or newer on the Node 22 branch, and npm. From this **root directory**:

```bash
npm ci           # root postinstall runs locked npm ci for backend + frontend automatically
npm --prefix backend run deps:check  # verifies the compiled SQLite binding
npm run dev      # NestJS --watch on 2785 + Vite HMR on 2886
```

Open **http://localhost:2886**. The Vite dev proxy sends `/api` and `/socket.io`
(including WebSocket upgrades) and `/mcp` to `http://localhost:2785`.
Local environment: create `backend/.env` from `backend/.env.example` and set required
backend secrets, database, and engine settings. The backend's dev process reads it
from `backend/`; Vite needs no public backend URL because requests are same-origin.
For local hot reload, **do not also run Compose** on ports 2886/2785.

You can also run each side independently:

```bash
npm run dev:backend
npm run dev:frontend
npm run build
```

## Docker — three isolated application containers

```bash
cp .env.example .env  # review and set production credentials/DB settings
docker compose up -d --build
docker compose ps
docker compose logs -f al-hakim-nginx al-hakim-dashboard al-hakim-api
```

- **Nginx** (`al-hakim-nginx`): `localhost:2886` → reverse proxy `/` to frontend 4173;
  `/api`, `/socket.io`, and `/mcp` to backend 2785. Injects a per-request CSP nonce
  into proxied HTML. It does not store/serve the React files itself.
- **Frontend** (`al-hakim-dashboard`): Node static server on **internal** port 4173;
  no published host port, no database and no Docker socket access.
- **Backend** (`al-hakim-api`): NestJS on 2785, with the existing Brave runtime,
  persistent session data and optional PostgreSQL/Redis/MinIO integrations. The API
  retains its existing loopback-only host mapping for maintenance.

The Compose file also includes the privileged **Docker socket proxy** (isolated on
an internal-only network) and optional storage/DB/cache containers. These are not
frontend/Nginx application processes. The frontend and Nginx are not on that proxy network.

For quick SQLite-based container testing (not hot reload):

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

## Health, network, and configuration

- Public ingress `/healthz`: `http://localhost:2886/healthz` (Nginx).
- Frontend private: `al-hakim-dashboard:4173/healthz` inside the Compose network.
- Backend: `http://127.0.0.1:2785/api/health/ready` (if the backend is healthy).
- Do not use `al-hakim-api` as a browser URL; Docker DNS exists only in the network.
- Keep `VITE_API_URL` and `VITE_WS_URL` empty for same-origin proxy routing.
- Set `APP_VERSION` to the backend version when building Docker images to keep the release badge aligned; local development automatically reads `backend/package.json`.
- Place public TLS termination in front of the 2886 loopback binding, or configure
  proper HTTPS on the external reverse proxy. Do not directly expose HTTP publicly.

## Migrating from the previous two-container checkout

Previous paths: `src/` → `backend/src/`; `dashboard/` → `frontend/`;
root `Dockerfile` → `backend/Dockerfile`; `dashboard/nginx.conf` →
`nginxconfig/nginx.conf`. The root package is now an orchestration package, not
the NestJS package; backend commands should use `npm --prefix backend ...`.
Production **named volume names are unchanged** (`al-hakim_data`,
`al-hakim_postgres-data`, etc.). SQLite development Compose continues to mount
`./data:/app/data`, so keep the existing root `data/` directory in place.
Always back up databases and session profiles first. Do **not** use `docker compose down -v`
when migrating an existing installation.

Existing integrations to the old dashboard Nginx container name must be changed to
`al-hakim-nginx`; the `al-hakim-dashboard` container now serves static assets only.
The bundled Helm chart in `backend/charts/` is **not** converted to this topology.

## Validation

- `docker compose config` validates interpolation and service wiring.
- `npm --prefix backend run build` checks NestJS types and compiler imports.
- `npm --prefix frontend run build` checks React/TypeScript and Vite output.
- `npm --prefix backend test -- --runInBand` runs backend Jest suites.
- `npm --prefix frontend run typecheck` checks frontend types.

### Native SQLite driver on Windows

The main auth/audit database always uses `better-sqlite3`, including when the data database is PostgreSQL. If startup reports `SQLITE_NATIVE_DRIVER_UNAVAILABLE`, follow `OPENWA_DEPENDENCY_DIAGNOSIS.md`. Rebuild the driver using the **same Node.js version as the running backend**. Do not delete database or session files to resolve a native binding problem.
