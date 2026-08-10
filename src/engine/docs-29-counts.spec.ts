import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `docs/29` states the same three figures in ten places — the intro, the architecture prose, a
 * mermaid node, two section headings, the §29.4 totals and the §29.8 summary. All ten are
 * hand-written restatements of what `engine-capability-matrix.ts` contains.
 *
 * Adding one interface method updated the matrix and §29.8 and left the other six behind, and
 * nothing noticed: the parity gates compare the matrix to the interface, and no check reads the
 * prose. This binds every count-shaped claim in the file to the source it restates.
 */
describe('docs/29 counts match the capability matrix', () => {
  const read = (...parts: string[]): string => readFileSync(join(__dirname, '..', '..', ...parts), 'utf8');

  /** Recount from the matrix source. Line-oriented on purpose — see the note on the fixture below. */
  const recount = () => {
    const lines = read('src', 'engine', 'engine-capability-matrix.ts').split('\n');
    const rows: { wwjs: string | null; baileys: string | null }[] = [];
    let current: { wwjs: string | null; baileys: string | null } | null = null;
    for (const line of lines) {
      if (/^ {2}[A-Za-z][A-Za-z0-9_]*: \{/.test(line)) {
        current = { wwjs: null, baileys: null };
        rows.push(current);
      }
      if (!current) continue;
      const wwjs = line.match(/wwjs: \{ ?status: '([a-z-]+)'/);
      if (wwjs && current.wwjs === null) current.wwjs = wwjs[1];
      const baileys = line.match(/baileys: \{ ?status: '([a-z-]+)'/);
      if (baileys && current.baileys === null) current.baileys = baileys[1];
    }
    const complete = rows.filter(r => r.wwjs && r.baileys);
    // A parse that dropped rows would understate every figure and make the whole file "agree".
    expect(complete.length).toBe(rows.length);
    expect(rows.length).toBeGreaterThan(80);

    const ok = (s: string | null): boolean => s === 'supported';
    const supported = rows.filter(r => ok(r.wwjs)).length + rows.filter(r => ok(r.baileys)).length;
    // The REST caller's view counts the two store-backed status reads as neutral rather than
    // wwjs-only; docs/29 states that adjustment explicitly where it uses the figure.
    const neutralRaw = rows.filter(r => ok(r.wwjs) && ok(r.baileys)).length;
    return { methods: rows.length, cells: rows.length * 2, supported, neutral: neutralRaw + 2 };
  };

  /** Every phrasing in the file that restates one of those figures. */
  const CLAIMS: { label: string; re: RegExp; of: 'methods' | 'cells' | 'supported' | 'neutral' }[] = [
    { label: 'intro coverage', re: /Coverage is total: all (\d+) `IWhatsAppEngine` methods/, of: 'methods' },
    { label: 'section guide', re: /Rows are the (\d+) `IWhatsAppEngine` methods/, of: 'methods' },
    { label: 'architecture prose', re: /`IWhatsAppEngine` interface \((\d+) methods/, of: 'methods' },
    { label: 'mermaid node', re: /IWhatsAppEngine - (\d+) methods/, of: 'methods' },
    { label: '29.4 heading', re: /contract view \((\d+) methods\)/, of: 'methods' },
    { label: '29.4 totals methods', re: /\*\*Totals:\*\* (\d+) methods/, of: 'methods' },
    { label: '29.4 totals cells', re: /\*\*Totals:\*\* \d+ methods → (\d+) adapter cells/, of: 'cells' },
    { label: '29.4 totals supported', re: /adapter cells: \*\*(\d+) ✅/, of: 'supported' },
    { label: '29.4 REST view', re: /From the REST caller's side: \*\*(\d+)\*\* methods/, of: 'neutral' },
    { label: '29.8 methods', re: /- \*\*(\d+)\*\* interface methods/, of: 'methods' },
    { label: '29.8 cells', re: /interface methods → \*\*(\d+)\*\* adapter cells/, of: 'cells' },
    { label: '29.8 supported', re: /adapter cells: \*\*(\d+) ✅\*\*/, of: 'supported' },
    { label: '29.8 restated supported', re: /Of the (\d+) ✅ cells/, of: 'supported' },
    { label: '29.8 REST view', re: /REST caller's view: \*\*(\d+)\*\* engine-neutral/, of: 'neutral' },
  ];

  it('states the same figures everywhere it states them', () => {
    const expected = recount();
    const doc = read('docs', '29-engine-capability-matrix.md');

    const wrong: string[] = [];
    for (const claim of CLAIMS) {
      const found = doc.match(claim.re);
      // A phrasing that stopped matching is drift too — the claim did not disappear, the check did.
      if (!found) {
        wrong.push(`${claim.label}: phrasing no longer found in the document`);
        continue;
      }
      const actual = Number(found[1]);
      if (actual !== expected[claim.of]) {
        wrong.push(`${claim.label}: says ${actual}, matrix has ${expected[claim.of]}`);
      }
    }

    expect(wrong).toEqual([]);
  });
});
