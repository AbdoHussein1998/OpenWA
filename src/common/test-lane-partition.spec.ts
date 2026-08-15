import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The doc-lint suites live in two hand-maintained lists in package.json: the `test:docs` script
 * runs them as explicit positionals, and the jest `testPathIgnorePatterns` array keeps them out of
 * the default unit lane. Nothing else knows the lists are a pair, so a suite added to one but not
 * the other drifts silently — excluded from `jest` yet never enumerated by `test:docs`, it runs in
 * no lane at all. And a rename that only reaches one list empties that lane the same way. Only a
 * spec that reads package.json the way both lanes do can see either drift.
 */
describe('Test lane partition', () => {
  const repoRoot = join(__dirname, '..', '..');
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: { 'test:docs'?: string };
    jest?: { testPathIgnorePatterns?: string[] };
  };

  /** Every spec path the `test:docs` script names as a positional, however the flags are ordered. */
  const docLane = (): Set<string> =>
    new Set((pkg.scripts['test:docs'] ?? '').split(/\s+/).filter(token => token.endsWith('.spec.ts')));

  /** The ignore patterns with `/node_modules/` dropped — it excludes dependency code, not a lane. */
  const unitLaneExcludes = (): string[] =>
    (pkg.jest?.testPathIgnorePatterns ?? []).filter(pattern => pattern !== '/node_modules/');

  /** A spec path as the ignore patterns write it: dots escaped, anchored at the end. */
  const asPattern = (path: string): string => `${path.replace(/\./g, '\\.')}$`;

  /** An ignore pattern back as the spec path the script would name. */
  const asPath = (pattern: string): string => pattern.replace(/\\\./g, '.').replace(/\$$/, '');

  it('lists the same suites in the test:docs script and the ignore patterns', () => {
    const docs = docLane();
    const excluded = unitLaneExcludes();

    // Guard the parser: lists that scanned to nothing would make the equality below pass vacuously.
    expect(docs.size).toBeGreaterThan(20);
    expect(excluded.length).toBeGreaterThan(20);

    const onlyInScript = [...docs].filter(path => !excluded.includes(asPattern(path)));
    const onlyInIgnored = excluded.filter(pattern => !docs.has(asPath(pattern)));
    if (onlyInScript.length || onlyInIgnored.length) {
      throw new Error(
        'test:docs and testPathIgnorePatterns name different suites — a suite listed in one but ' +
          'not the other runs in no lane (the unit lane ignores it, the docs lane never invokes ' +
          'it). Add the suite to both lists in package.json. ' +
          `Only in test:docs: ${onlyInScript.join(', ') || '(none)'}. ` +
          `Only in testPathIgnorePatterns: ${onlyInIgnored.join(', ') || '(none)'}.`,
      );
    }
  });

  it('names suites that exist on disk', () => {
    const paths = [...new Set([...docLane(), ...unitLaneExcludes().map(asPath)])];
    expect(paths.length).toBeGreaterThan(20);

    // A renamed spec leaves a stale entry in whichever list was not updated — and an empty lane.
    const missing = paths.filter(path => !existsSync(join(repoRoot, path)));
    expect(missing).toEqual([]);
  });
});
