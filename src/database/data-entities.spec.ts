import { getMetadataArgsStorage, type EntityTarget } from 'typeorm';
import { loadDataEntities } from './data-entities';

// This regression test checks the *constructor objects* that the runtime and
// migration CLI now share. Comparing filename globs alone does not test TypeORM
// metadata registration (and previously missed the reported startup failures).
describe('data entity registration', () => {
  it('discovers every data-owned exported @Entity constructor exactly once', () => {
    const entities = loadDataEntities();
    const targets = new Set(getMetadataArgsStorage().tables.map(table => table.target));
    expect(entities.length).toBeGreaterThan(0);
    expect(new Set(entities).size).toBe(entities.length);
    expect(entities.every(entity => targets.has(entity))).toBe(true);
  });

  it('includes the classes involved in the observed startup errors', () => {
    const names = (loadDataEntities() as EntityTarget<unknown>[]).map(
      entity => (entity as { name?: string }).name,
    );
    expect(names).toEqual(expect.arrayContaining([
      'Session', 'WebhookDeliveryFailure', 'WebhookOutboxEvent', 'StatusUpdate', 'LidMapping',
    ]));
  });

  it('does not register any main-owned entity on the data connection', () => {
    const names = loadDataEntities().map(entity => (entity as { name?: string }).name);
    for (const mainName of ['ApiKey', 'AuditLog', 'TeamLeader', 'Agent', 'AgentTemplateSendUsage']) {
      expect(names).not.toContain(mainName);
    }
  });
});
