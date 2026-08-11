import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `docs/06-api-specification.md` is the reference a REST consumer reads when there is no SDK — curl,
 * Postman, n8n. It restates the published contract by hand, and nothing bound the two, so operations
 * shipped without ever reaching it: `GET`/`PATCH /api/sessions/{id}/config` are implemented by all
 * five SDKs and documented only in `docs/05`, and the integration redrive route was documented
 * nowhere at all.
 *
 * This gate compares the document's route headings to `openapi.json` in both directions. An
 * operation added without a heading, a heading left behind after a route is renamed, and a stale
 * allowlist entry all fail here.
 *
 * Operations deliberately documented in another file carry an allowlist entry naming that file, and
 * the gate reads the file to confirm the path is really there — otherwise "documented in docs/25"
 * would be an unchecked claim, which is the exact failure this gate exists to prevent.
 */
describe('docs/06 matches the published contract', () => {
  const REPO = join(__dirname, '..', '..', '..');
  const read = (...parts: string[]): string => readFileSync(join(REPO, ...parts), 'utf8');

  const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

  /** The contract writes `{id}`, the prose writes `:id`. Normalise both to `:id`. */
  const normalise = (path: string): string => path.replace(/\{(\w+)\}/g, ':$1').replace(/\/+$/, '');

  /**
   * A path with its parameter segments collapsed. Used only for the allowlist backing check: the
   * contract names a segment `{path}` where docs/25 names the same segment `:route`, and a parameter
   * name is a documentation choice rather than part of the route's identity.
   */
  const shape = (path: string): string =>
    path
      .split('/')
      .map(segment => (segment.startsWith(':') || segment.startsWith('{') ? ':*' : segment))
      .join('/');

  const contractOperations = (): Set<string> => {
    const spec = JSON.parse(read('openapi.json')) as { paths: Record<string, Record<string, unknown>> };
    const operations = new Set<string>();
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of Object.keys(item)) {
        if (METHODS.includes(method)) operations.add(`${method.toUpperCase()} ${normalise(path)}`);
      }
    }
    return operations;
  };

  const documentedHeadings = (): Set<string> =>
    new Set(
      [...read('docs', '06-api-specification.md').matchAll(/^#### (GET|POST|PUT|PATCH|DELETE) (\S+)/gm)].map(
        match => `${match[1]} ${normalise(match[2])}`,
      ),
    );

  /**
   * Operations documented outside docs/06, each naming the file that documents it. The backing check
   * below reads that file, so an entry cannot become a silent exemption.
   */
  const DOCUMENTED_ELSEWHERE = new Map<string, string>([
    ['GET /api/ingress/:pluginId/:instanceId/:path', 'docs/25-integration-fabric.md'],
    ['POST /api/ingress/:pluginId/:instanceId/:path', 'docs/25-integration-fabric.md'],
    ['PUT /api/ingress/:pluginId/:instanceId/:path', 'docs/25-integration-fabric.md'],
    ['PATCH /api/ingress/:pluginId/:instanceId/:path', 'docs/25-integration-fabric.md'],
    ['DELETE /api/ingress/:pluginId/:instanceId/:path', 'docs/25-integration-fabric.md'],
    ['GET /api/integration/plugins/:pluginId/instances', 'docs/25-integration-fabric.md'],
    ['POST /api/integration/plugins/:pluginId/instances', 'docs/25-integration-fabric.md'],
    ['GET /api/integration/plugins/:pluginId/instances/:instanceId', 'docs/25-integration-fabric.md'],
    ['PATCH /api/integration/plugins/:pluginId/instances/:instanceId', 'docs/25-integration-fabric.md'],
    ['DELETE /api/integration/plugins/:pluginId/instances/:instanceId', 'docs/25-integration-fabric.md'],
    [
      'POST /api/integration/plugins/:pluginId/instances/:instanceId/regenerate-secret',
      'docs/25-integration-fabric.md',
    ],
    ['GET /api/sessions/:id/config', 'docs/05-database-design.md'],
    ['PATCH /api/sessions/:id/config', 'docs/05-database-design.md'],
  ]);

  /**
   * Headings with no contract operation, and why the contract cannot carry them. `POST /mcp` is
   * mounted on raw Express outside Nest, so the Swagger scanner never sees it.
   */
  const NOT_IN_CONTRACT = new Set(['POST /mcp']);

  /** True when `file` contains a path of the same shape as `operation`. */
  const backs = (file: string, operation: string): boolean => {
    const wanted = shape(operation.slice(operation.indexOf(' ') + 1));
    const body = read(...file.split('/'));
    return [...body.matchAll(/\/api\/[A-Za-z0-9:{}_\-/]+/g)].some(match => shape(normalise(match[0])) === wanted);
  };

  it('documents every contract operation, or allowlists it to a file that really documents it', () => {
    const operations = contractOperations();
    const headings = documentedHeadings();

    expect(operations.size).toBeGreaterThan(150);
    expect(headings.size).toBeGreaterThan(150);

    const undocumented = [...operations]
      .filter(operation => !headings.has(operation) && !DOCUMENTED_ELSEWHERE.has(operation))
      .sort();
    expect(undocumented).toEqual([]);
  });

  it('every allowlisted operation is really documented in the file it names', () => {
    expect(DOCUMENTED_ELSEWHERE.size).toBeGreaterThan(5);

    const unbacked = [...DOCUMENTED_ELSEWHERE]
      .filter(([operation, file]) => !backs(file, operation))
      .map(([operation, file]) => `${operation} claims ${file}, which does not contain that path`);
    expect(unbacked).toEqual([]);
  });

  it('has no heading for a route the contract no longer publishes', () => {
    const operations = contractOperations();
    const stale = [...documentedHeadings()]
      .filter(heading => !operations.has(heading) && !NOT_IN_CONTRACT.has(heading))
      .sort();
    expect(stale).toEqual([]);
  });

  it('has no stale allowlist entry', () => {
    const operations = contractOperations();
    const headings = documentedHeadings();

    const stale = [...DOCUMENTED_ELSEWHERE.keys()]
      .filter(operation => !operations.has(operation) || headings.has(operation))
      .sort();
    expect(stale).toEqual([]);
  });

  // The gate's own controls. Without these, a matcher that silently stops working is
  // indistinguishable from a document that is correct.
  describe('the checks themselves can fail', () => {
    it('reports an operation with neither a heading nor an allowlist entry', () => {
      const operations = new Set(['GET /api/widgets']);
      const headings = new Set<string>();
      const undocumented = [...operations].filter(
        operation => !headings.has(operation) && !DOCUMENTED_ELSEWHERE.has(operation),
      );
      expect(undocumented).toEqual(['GET /api/widgets']);
    });

    it('reports an allowlist entry whose file does not contain the path', () => {
      expect(backs('docs/05-database-design.md', 'GET /api/nowhere/:id')).toBe(false);
    });

    it('accepts a documenting file that spells the parameter differently', () => {
      // docs/25 writes `:route` where the contract writes `{path}`.
      expect(backs('docs/25-integration-fabric.md', 'GET /api/ingress/:pluginId/:instanceId/:path')).toBe(true);
    });
  });
});
