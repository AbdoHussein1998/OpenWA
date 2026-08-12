import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

/**
 * The published image has no `USER` directive by design: docker-entrypoint.sh starts as root to fix
 * named-volume ownership and then drops via `exec gosu openwa`. That drop is the only thing keeping
 * an internet-facing Node process (and its Chromium subprocess) off uid 0, and
 * `scripts/smoke-test-non-root.sh` is the only check of it.
 *
 * The script existed but no workflow ran it — its sole appearance in ci.yml was inside a comment
 * explaining why shellcheck names it. A change that left the process as root therefore passed lint,
 * every test job, the multi-arch build, the boot smoke and the image scan, and was promoted to
 * `latest`. These pin that the script is INVOKED, because a mention is not a gate.
 */

const workflowDir = path.join(__dirname, '..', '..', '.github', 'workflows');

type Workflow = { jobs?: Record<string, { steps?: Array<{ name?: string; run?: string; with?: unknown }> }> };

function runCommandsOf(file: string): string[] {
  const doc = yaml.load(fs.readFileSync(path.join(workflowDir, file), 'utf8')) as Workflow;
  return Object.values(doc.jobs ?? {}).flatMap(job => (job.steps ?? []).map(step => step.run ?? ''));
}

describe('the non-root drop is enforced, not merely documented', () => {
  // A `run:` extractor that silently matched nothing would make every assertion below vacuously
  // pass. Anchor it on a script the workflows have always invoked.
  it('extracts run commands from the workflows', () => {
    expect(runCommandsOf('ci.yml').join('\n')).toContain('smoke-test-backup-restore.sh');
  });

  it('invokes the non-root smoke test from ci.yml', () => {
    const invocations = runCommandsOf('ci.yml').filter(run => run.includes('smoke-test-non-root.sh'));
    expect(invocations.length).toBeGreaterThan(0);
  });

  // The Dockerfile relies on the entrypoint's gosu drop rather than a USER directive. If that ever
  // changes to a real USER line the smoke test still passes, but this records WHY the directive is
  // absent, so its absence is never read as an oversight and "fixed" by deleting the drop.
  it('keeps the entrypoint gosu drop the image depends on', () => {
    const entrypoint = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-entrypoint.sh'), 'utf8');
    expect(entrypoint).toMatch(/exec\s+gosu\s+openwa/);
  });
});
