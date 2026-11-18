import { readFileSync } from 'fs';
import { join } from 'path';
// js-yaml has no bundled types here; require + cast (matches the repo's plugin-loader pattern).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('js-yaml') as { load: (src: string) => unknown };

interface ComposeFile {
  services: Record<string, {
    networks?: string[];
    build?: { context?: string; dockerfile?: string };
    environment?: string[];
    ports?: string[];
    depends_on?: Record<string, unknown>;
  }>;
  networks: Record<string, { internal?: boolean }>;
}

/**
 * Regression lock: the Docker socket proxy must live on a dedicated
 * internal network that untrusted peers cannot reach.
 */
describe('docker-compose network segmentation', () => {
  const compose = yaml.load(readFileSync(join(__dirname, '../../../../docker-compose.yml'), 'utf8')) as ComposeFile;

  it('declares an internal-only network for the docker socket proxy', () => {
    expect(compose.networks['internal-docker'].internal).toBe(true);
  });

  it('puts docker-proxy ONLY on the internal network (not the shared app network)', () => {
    expect(compose.services['docker-proxy'].networks).toEqual(['internal-docker']);
  });

  it('lets al-hakim-api reach the proxy via the internal network', () => {
    expect(compose.services['al-hakim-api'].networks).toContain('internal-docker');
  });

  it('deploys the backend and frontend as independent builds and containers', () => {
    const backend = compose.services['al-hakim-api'];
    const frontend = compose.services['al-hakim-dashboard'];
    expect(backend.build?.context).toBe('./backend');
    expect(backend.build?.dockerfile).toBe('Dockerfile');
    expect(frontend.build?.context).toBe('./frontend');
    expect(frontend.build?.dockerfile).toBe('Dockerfile');
    const ingress = compose.services['al-hakim-nginx'];
    expect(ingress.build?.context).toBe('./nginxconfig');
    expect(ingress.build?.dockerfile).toBe('Dockerfile');
    expect(ingress.depends_on).toHaveProperty('al-hakim-api');
    expect(ingress.depends_on).toHaveProperty('al-hakim-dashboard');
    expect(backend.environment).toContain('SERVE_DASHBOARD=false');
    expect(frontend.depends_on).toBeUndefined();
  });

  it('keeps the frontend away from the docker socket proxy network', () => {
    expect(compose.services['al-hakim-dashboard'].networks).toEqual(['al-hakim-network']);
    expect(compose.services['al-hakim-dashboard'].networks).not.toContain('internal-docker');
    expect(compose.services['al-hakim-nginx'].networks).not.toContain('internal-docker');
  });

  it('has a standalone frontend reverse proxy for API, Socket.IO and MCP', () => {
    const nginx = readFileSync(join(__dirname, '../../../../nginxconfig/nginx.conf'), 'utf8');
    expect(nginx).toContain('set $backend_origin http://al-hakim-api:2785;');
    expect(nginx).toContain('set $frontend_origin http://al-hakim-dashboard:4173;');
    expect(nginx).toContain('location ^~ /api/');
    expect(nginx).toContain('location ^~ /socket.io/');
    expect(nginx).toContain('location ^~ /mcp/');
    expect(nginx).toContain("sub_filter '__AL_HAKIM_CSP_NONCE__' $request_id;");
  });
});
