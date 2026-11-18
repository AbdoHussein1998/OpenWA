/**
 * Minimal read-only production server for Vite assets.
 * Nginx is a DIFFERENT container and owns TLS/proxy headers/CSP nonce injection.
 * Uses only Node built-ins: no runtime dependency on the Vite development server.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('./dist/', import.meta.url)));
const port = Number(process.env.PORT || '4173');
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.pdf': 'application/pdf',
};

createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok\n');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); res.end(); return; }
  if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..')) {
    res.writeHead(400); res.end(); return;
  }
  let file = resolve(root, '.' + pathname);
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403); res.end(); return;
  }
  let fileStat;
  try { fileStat = await stat(file); } catch { /* unknown SPA path or asset */ }
  if (!fileStat?.isFile()) {
    // A missing file is a real 404. Only extensionless SPA navigation requests get index.html.
    if (pathname.startsWith('/assets/') || extname(pathname) || pathname.startsWith('/api/') ||
        pathname === '/api' || pathname.startsWith('/socket.io') || pathname.startsWith('/mcp')) {
      res.writeHead(404); res.end('Not Found'); return;
    }
    file = resolve(root, 'index.html');
    try { fileStat = await stat(file); }
    catch { res.writeHead(503); res.end('Frontend not built'); return; }
  }
  const type = mime[extname(file).toLowerCase()] || 'application/octet-stream';
  const index = extname(file).toLowerCase() === '.html';
  res.writeHead(200, {
    'Content-Type': type,
    // HTML must never be cached: nginx injects a per-response CSP nonce.
    'Cache-Control': index ? 'no-store' : pathname.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable' : 'no-cache',
    'Content-Length': fileStat.size,
  });
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = createReadStream(file);
  stream.on('error', () => { res.destroy(); });
  stream.pipe(res);
}).listen(port, '0.0.0.0', () => {
  console.log(`al-hakim frontend static server listening on :${port}`);
});
