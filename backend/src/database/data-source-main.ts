import { DataSource } from 'typeorm';
import * as path from 'path';
import { loadCliEnv } from './load-cli-env';
import { sqliteDataMainPathCollision } from '../config/env.validation';
import { ApiKey } from '../modules/auth/entities/api-key.entity';
import { AuditLog } from '../modules/audit/entities/audit-log.entity';
import { TeamLeader } from '../modules/teamleader/entities/team-leader.entity';
import { Agent } from '../modules/teamleader/entities/agent.entity';
import { AgentTemplateSendUsage } from '../modules/teamleader/entities/agent-template-send-usage.entity';

// Load environment variables with the app's precedence (mirrors data-source.ts / main.ts).
loadCliEnv();

// The TypeORM CLI does not run ConfigModule's validate(). Reject a SQLite data/main
// database path collision for either migration entry point.
const sqlitePathCollision = sqliteDataMainPathCollision(process.env);
if (sqlitePathCollision) {
  throw new Error(sqlitePathCollision);
}

/**
 * Standalone TypeORM CLI DataSource for the MAIN connection (auth, audit, team leader/agents).
 *
 * Mirrors the runtime main connection in app.module.ts: SQLite database path,
 * entity classes, and the dedicated main migrations. The CLI always disables
 * synchronize because schema changes are managed through migrations.
 *
 * Usage: npm run migration:run:main (dev) / migration:run:main:prod (compiled).
 */
const mainDataSource = new DataSource({
  type: 'better-sqlite3',
  // MAIN_DATABASE_NAME must match the runtime main database path.
  database: process.env.MAIN_DATABASE_NAME || './data/main.sqlite',
  entities: [
    ApiKey,
    AuditLog,
    TeamLeader,
    Agent,
    AgentTemplateSendUsage,
  ],
  migrations: [path.join(__dirname, 'migrations-main', '*{.ts,.js}').replace(/\\/g, '/')],
  synchronize: false,
  logging: process.env.DATABASE_LOGGING === 'true',
});

export default mainDataSource;
