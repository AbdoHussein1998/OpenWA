import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `docs/10-devops-infrastructure.md` introduces its metric table with "the complete set — nothing
 * else is emitted". That is a claim about ABSENCE, and nothing bound it to the renderer: every
 * metric added after the table was written kept the claim green while making it false. It had
 * drifted to listing 10 of the 15 series `MetricsService` actually emits.
 *
 * An operator reads that table to decide what to alert on, so a missing row is not cosmetic — it is
 * a signal nobody knows exists.
 *
 * This gate compares the table against the renderer's own emission sites. A metric added to the
 * service without a row, a row left behind after the service stops emitting it, or a Type column
 * that disagrees with the `# TYPE` line all fail here.
 */
describe('docs/10 metric table matches MetricsService', () => {
  const read = (...parts: string[]): string => readFileSync(join(__dirname, '..', '..', ...parts), 'utf8');

  /**
   * Emitted series, read from the two forms the renderer uses:
   *   - `gauge('openwa_x', …)` — the helper pushes HELP/TYPE/value, always a gauge.
   *   - `# TYPE openwa_x counter|gauge` — the hand-written blocks.
   * Both carry the type, so the doc's Type column is checked against the source rather than assumed.
   */
  const emitted = (): Map<string, string> => {
    const source = read('src', 'modules', 'metrics', 'metrics.service.ts');
    const found = new Map<string, string>();
    for (const [, name] of source.matchAll(/\bgauge\(\s*'(openwa_[a-z_]+)'/g)) {
      found.set(name, 'gauge');
    }
    for (const [, name, type] of source.matchAll(/# TYPE (openwa_[a-z_]+) (gauge|counter)/g)) {
      found.set(name, type);
    }
    return found;
  };

  /** The table rows: `| \`openwa_x\` | type | labels | meaning |`. */
  const documented = (): Map<string, string> => {
    const doc = read('docs', '10-devops-infrastructure.md');
    const start = doc.indexOf('**Exported metric names**');
    expect(start).toBeGreaterThan(-1);
    const table = doc.slice(start);
    const rows = new Map<string, string>();
    for (const line of table.split('\n')) {
      if (!line.startsWith('|')) {
        if (rows.size > 0) break; // past the table
        continue;
      }
      const cells = line.split('|').map(cell => cell.trim());
      const name = cells[1]?.match(/^`(openwa_[a-z_]+)`$/)?.[1];
      if (name) rows.set(name, cells[2]);
    }
    return rows;
  };

  // Positive control. Both readers are regex-based, and a regex that matches nothing would make
  // every comparison below pass vacuously — two empty sets are equal. Fail loudly instead.
  it('both readers actually read something', () => {
    expect(emitted().size).toBeGreaterThanOrEqual(10);
    expect(emitted().get('openwa_up')).toBe('gauge');
    expect(documented().size).toBeGreaterThanOrEqual(10);
    expect(documented().get('openwa_up')).toBe('gauge');
  });

  it('lists exactly the series the renderer emits', () => {
    expect([...documented().keys()].sort()).toEqual([...emitted().keys()].sort());
  });

  it('gives each series the type the renderer declares', () => {
    expect(Object.fromEntries([...documented()].sort())).toEqual(Object.fromEntries([...emitted()].sort()));
  });
});
