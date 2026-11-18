import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local development reads the backend version. A standalone frontend Docker build
// cannot (and must not) copy the backend project into the frontend image, so
// Compose supplies APP_VERSION as a build argument. Use frontend version as a
// fallback for independent builds without APP_VERSION.
const backendPackage = new URL('../backend/package.json', import.meta.url);
const localPackage = new URL('./package.json', import.meta.url);
const { version: pkgVersion } = JSON.parse(
  readFileSync(existsSync(backendPackage) ? backendPackage : localPackage, 'utf-8'),
) as { version: string };

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  appType: 'spa', // Enable SPA fallback for client-side routing
  define: {
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION || pkgVersion),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    port: 2886,
    proxy: {
      // Proxy only the actual backend API namespace:
      //   /api
      //   /api/...
      //
      // A plain "/api" prefix would also match the frontend route
      // "/api-keys", causing a hard refresh of that page to be sent
      // to NestJS and return 404 instead of letting Vite's SPA fallback
      // serve index.html.
      '^/api(?:/|\\?|$)': {
        target: 'http://localhost:2785',
        changeOrigin: true,
        secure: false,
      },

      // Proxy the WebSocket (socket.io) transport so the dashboard's real-time
      // chats/sessions streams work against the dev backend.
      '/mcp': {
        target: 'http://localhost:2785',
        changeOrigin: true,
        secure: false,
      },
      '/socket.io': {
        target: 'http://localhost:2785',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});