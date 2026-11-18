# Al-Hakim Frontend

React/Vite dashboard in a standalone folder and Node static-server image.

- `npm ci` installs frontend dependencies.
- `npm run dev` starts Vite with hot reload at `http://localhost:2886` and proxies `/api`, `/socket.io`, `/mcp` to local NestJS port 2785.
- `npm run build` compiles the frontend into `dist/`.
- `node server.mjs` serves a previously built `dist/` on port 4173, only for Nginx upstream use.

For both local servers from one command, go to the **repository root** and run `npm run dev`.
