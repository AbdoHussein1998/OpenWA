import * as fs from 'fs';
import * as path from 'path';
import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * Structural invariants of the committed snapshot.
 *
 * `openapi:check` proves the file matches a fresh export; it cannot say whether either is correct.
 * These assert properties the specification requires, so a regression fails here rather than in a
 * consumer's generator.
 */

const OPERATION_KEYS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

const snapshot = (): OpenAPIObject =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'openapi.json'), 'utf8')) as OpenAPIObject;

describe('openapi.json structural invariants', () => {
  // OpenAPI 3.0 requires every template expression in a path to resolve to a declared path parameter,
  // on the path item or on the operation. A route whose handler never binds the parameter — a
  // class-level prefix nothing reads, or a wildcard read off the request — publishes the template with
  // nothing to fill it, and a generated client has no argument for that segment.
  it('every path template variable is declared as a path parameter', () => {
    const doc = snapshot();
    const undeclared: string[] = [];

    for (const [route, item] of Object.entries(doc.paths)) {
      const templated = [...route.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
      if (!templated.length) continue;

      const itemLevel = (item.parameters ?? [])
        .filter(p => 'in' in p && p.in === 'path')
        .map(p => ('name' in p ? p.name : ''));

      for (const [method, operation] of Object.entries(item)) {
        if (!OPERATION_KEYS.has(method)) continue;
        const declared = new Set([
          ...itemLevel,
          ...((operation as { parameters?: { in?: string; name?: string }[] }).parameters ?? [])
            .filter(p => p.in === 'path')
            .map(p => p.name ?? ''),
        ]);
        for (const variable of templated) {
          if (!declared.has(variable)) undeclared.push(`${method.toUpperCase()} ${route} → {${variable}}`);
        }
      }
    }

    expect(undeclared).toEqual([]);
  });

  it('every operation declares at least one response', () => {
    const doc = snapshot();
    const silent = Object.entries(doc.paths).flatMap(([route, item]) =>
      Object.entries(item)
        .filter(([method]) => OPERATION_KEYS.has(method))
        .filter(([, operation]) => !Object.keys((operation as { responses?: object }).responses ?? {}).length)
        .map(([method]) => `${method.toUpperCase()} ${route}`),
    );

    expect(silent).toEqual([]);
  });
});
