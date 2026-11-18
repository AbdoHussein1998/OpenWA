import mainDataSource from './data-source-main';
import { ApiKey } from '../modules/auth/entities/api-key.entity';
import { AuditLog } from '../modules/audit/entities/audit-log.entity';
import { TeamLeader } from '../modules/teamleader/entities/team-leader.entity';
import { Agent } from '../modules/teamleader/entities/agent.entity';
import { AgentTemplateSendUsage } from '../modules/teamleader/entities/agent-template-send-usage.entity';

describe('main CLI DataSource', () => {
  it('targets the always-SQLite main connection', () => {
    expect(mainDataSource.options.type).toBe('better-sqlite3');
  });

  it('uses the main-owned migrations, not the data migrations', () => {
    const migrations = (mainDataSource.options.migrations as string[]).join(' ');
    expect(migrations).toContain('migrations-main');
  });

  it('registers main-owned entity classes rather than glob strings', () => {
    const entities = mainDataSource.options.entities;
    expect(entities).toEqual([
      ApiKey, AuditLog, TeamLeader, Agent, AgentTemplateSendUsage,
    ]);
  });

  it("defaults to './data/main.sqlite' when MAIN_DATABASE_NAME is unset", () => {
    const previous = process.env.MAIN_DATABASE_NAME;
    delete process.env.MAIN_DATABASE_NAME;
    jest.resetModules();
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./data-source-main') as typeof import('./data-source-main');
      expect(String(mod.default.options.database)).toBe('./data/main.sqlite');
    } finally {
      if (previous !== undefined) process.env.MAIN_DATABASE_NAME = previous;
      else delete process.env.MAIN_DATABASE_NAME;
      jest.resetModules();
    }
  });

  it('honors MAIN_DATABASE_NAME when configured', () => {
    const previous = process.env.MAIN_DATABASE_NAME;
    process.env.MAIN_DATABASE_NAME = '/tmp/test-main.sqlite';
    jest.resetModules();
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./data-source-main') as typeof import('./data-source-main');
      expect(String(mod.default.options.database)).toBe('/tmp/test-main.sqlite');
    } finally {
      if (previous !== undefined) process.env.MAIN_DATABASE_NAME = previous;
      else delete process.env.MAIN_DATABASE_NAME;
      jest.resetModules();
    }
  });

  it('rejects a DATA SQLite path that points to the MAIN SQLite database', () => {
    const prevType = process.env.DATABASE_TYPE;
    const prevMain = process.env.MAIN_DATABASE_NAME;
    const prevData = process.env.DATABASE_NAME;

    process.env.DATABASE_TYPE = 'sqlite';
    process.env.MAIN_DATABASE_NAME = '/tmp/cli-guard-main.sqlite';
    process.env.DATABASE_NAME = '/tmp/cli-guard-main.sqlite';
    jest.resetModules();
    try {
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('./data-source-main');
      }).toThrow(/DATABASE_NAME/);
    } finally {
      if (prevType !== undefined) process.env.DATABASE_TYPE = prevType;
      else delete process.env.DATABASE_TYPE;
      if (prevMain !== undefined) process.env.MAIN_DATABASE_NAME = prevMain;
      else delete process.env.MAIN_DATABASE_NAME;
      if (prevData !== undefined) process.env.DATABASE_NAME = prevData;
      else delete process.env.DATABASE_NAME;
      jest.resetModules();
    }
  });
});
