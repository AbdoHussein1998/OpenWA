


import {
  DataSource,
  QueryRunner,
} from 'typeorm';

import {
  CreateAuthAuditTables1779900000000,
} from '../1779900000000-CreateAuthAuditTables';

import {
  AddTeamLeaderAgentPrincipals1788686000000,
} from '../1788686000000-AddTeamLeaderAgentPrincipals';

import {
  AddAgentTemplateSendQuota1788868800000,
} from '../1788868800000-AddAgentTemplateSendQuota';

const USAGE_TABLE =
  'agent_template_send_usage';

const CONSUMED_INDEX =
  'IDX_agent_template_send_usage_agent_status_consumed_at';

const RESERVATION_INDEX =
  'IDX_agent_template_send_usage_agent_status_reservation_expires_at';

/**
 * Regression coverage for the Agent stored-template rolling quota migration.
 *
 * The migration belongs to the `main` SQLite database:
 *
 *   main DB:
 *     team_leaders
 *     agents
 *     api_keys
 *     agent_template_send_usage
 *
 *   data DB:
 *     sessions
 *
 * Therefore agent_template_send_usage.agentId is a real foreign key to
 * agents.id, while sessionId is intentionally only a varchar identifier.
 *
 * These tests run the real main-database migration chain instead of building a
 * synthetic Agent table, so they also protect the upgrade path from an existing
 * Team Leader / Agent installation.
 */
describe(
  'AddAgentTemplateSendQuota1788868800000 migration',
  () => {
    let dataSource: DataSource;
    let queryRunner: QueryRunner;

    beforeEach(async () => {
      dataSource = new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: [],
        synchronize: false,
      });

      await dataSource.initialize();

      queryRunner =
        dataSource.createQueryRunner();

      // SQLite only enforces declared foreign keys when this pragma is enabled.
      // Explicitly enabling it makes the cascade test independent of driver
      // defaults and verifies the database integrity contract itself.
      await queryRunner.query(
        'PRAGMA foreign_keys = ON',
      );
    });

    afterEach(async () => {
      if (
        queryRunner &&
        !queryRunner.isReleased
      ) {
        await queryRunner.release();
      }

      if (
        dataSource?.isInitialized
      ) {
        await dataSource.destroy();
      }
    });

    const runPrincipalBaseline =
      async (): Promise<void> => {
        await new CreateAuthAuditTables1779900000000().up(
          queryRunner,
        );

        await new AddTeamLeaderAgentPrincipals1788686000000().up(
          queryRunner,
        );
      };

    const insertExistingAgent =
      async (
        overrides: {
          teamLeaderId?: string;
          agentId?: string;
          assignedSessionId?: string | null;
        } = {},
      ): Promise<{
        teamLeaderId: string;
        agentId: string;
      }> => {
        const teamLeaderId =
          overrides.teamLeaderId ??
          'team-leader-1';

        const agentId =
          overrides.agentId ??
          'agent-1';

        await queryRunner.query(
          `INSERT INTO "team_leaders" ` +
            `("id", "name", "email") ` +
            `VALUES (?, ?, ?)`,
          [
            teamLeaderId,
            'Ahmed Hassan',
            `${teamLeaderId}@example.com`,
          ],
        );

        await queryRunner.query(
          `INSERT INTO "agents" ` +
            `("id", "name", "email", "teamLeaderId", "assignedSessionId") ` +
            `VALUES (?, ?, ?, ?, ?)`,
          [
            agentId,
            'Mohamed Ali',
            'mohamed@example.com',
            teamLeaderId,
            overrides.assignedSessionId ===
              undefined
              ? 'session-1'
              : overrides.assignedSessionId,
          ],
        );

        return {
          teamLeaderId,
          agentId,
        };
      };

    it(
      'fails clearly when the Agent principal migration has not created agents yet',
      async () => {
        await new CreateAuthAuditTables1779900000000().up(
          queryRunner,
        );

        await expect(
          new AddAgentTemplateSendQuota1788868800000().up(
            queryRunner,
          ),
        ).rejects.toThrow(
          'agents table is missing; run AddTeamLeaderAgentPrincipals1788686000000 first',
        );
      },
    );

    it(
      'adds a nullable quota column and preserves an existing Agent as unlimited',
      async () => {
        await runPrincipalBaseline();

        const { agentId } =
          await insertExistingAgent();

        await new AddAgentTemplateSendQuota1788868800000().up(
          queryRunner,
        );

        const agentsTable =
          await queryRunner.getTable(
            'agents',
          );

        expect(
          agentsTable,
        ).toBeDefined();

        const quotaColumn =
          agentsTable?.columns.find(
            column =>
              column.name ===
              'templateSendLimit24h',
          );

        expect(
          quotaColumn,
        ).toBeDefined();

        expect(
          quotaColumn?.isNullable,
        ).toBe(
          true,
        );

        const rows =
          (await queryRunner.query(
            `SELECT ` +
              `"id", ` +
              `"name", ` +
              `"email", ` +
              `"teamLeaderId", ` +
              `"assignedSessionId", ` +
              `"templateSendLimit24h" ` +
              `FROM "agents" ` +
              `WHERE "id" = ?`,
            [agentId],
          )) as Array<{
            id: string;
            name: string;
            email: string | null;
            teamLeaderId: string;
            assignedSessionId: string | null;
            templateSendLimit24h: number | null;
          }>;

        expect(
          rows,
        ).toHaveLength(
          1,
        );

        expect(
          rows[0],
        ).toEqual({
          id: agentId,
          name: 'Mohamed Ali',
          email: 'mohamed@example.com',
          teamLeaderId:
            'team-leader-1',
          assignedSessionId:
            'session-1',
          templateSendLimit24h:
            null,
        });
      },
    );

    it(
      'creates the usage table with the exact quota columns and working defaults',
      async () => {
        await runPrincipalBaseline();

        const { agentId } =
          await insertExistingAgent();

        await new AddAgentTemplateSendQuota1788868800000().up(
          queryRunner,
        );

        const usageTable =
          await queryRunner.getTable(
            USAGE_TABLE,
          );

        expect(
          usageTable,
        ).toBeDefined();

        const columns =
          usageTable?.columns.map(
            column => ({
              name: column.name,
              isNullable:
                column.isNullable,
              isPrimary:
                column.isPrimary,
            }),
          );

        expect(
          columns,
        ).toEqual(
          expect.arrayContaining([
            {
              name: 'id',
              isNullable: false,
              isPrimary: true,
            },
            {
              name: 'agentId',
              isNullable: false,
              isPrimary: false,
            },
            {
              name: 'sessionId',
              isNullable: false,
              isPrimary: false,
            },
            {
              name: 'status',
              isNullable: false,
              isPrimary: false,
            },
            {
              name:
                'reservationExpiresAt',
              isNullable: true,
              isPrimary: false,
            },
            {
              name: 'consumedAt',
              isNullable: true,
              isPrimary: false,
            },
            {
              name: 'createdAt',
              isNullable: false,
              isPrimary: false,
            },
          ]),
        );

        expect(
          columns,
        ).toHaveLength(
          7,
        );

        await queryRunner.query(
          `INSERT INTO "${USAGE_TABLE}" ` +
            `("id", "agentId", "sessionId") ` +
            `VALUES (?, ?, ?)`,
          [
            'usage-1',
            agentId,
            'session-1',
          ],
        );

        const rows =
          (await queryRunner.query(
            `SELECT ` +
              `"status", ` +
              `"reservationExpiresAt", ` +
              `"consumedAt", ` +
              `"createdAt" ` +
              `FROM "${USAGE_TABLE}" ` +
              `WHERE "id" = ?`,
            ['usage-1'],
          )) as Array<{
            status: string;
            reservationExpiresAt: string | null;
            consumedAt: string | null;
            createdAt: string | null;
          }>;

        expect(
          rows,
        ).toHaveLength(
          1,
        );

        expect(
          rows[0].status,
        ).toBe(
          'reserved',
        );

        expect(
          rows[0].reservationExpiresAt,
        ).toBeNull();

        expect(
          rows[0].consumedAt,
        ).toBeNull();

        expect(
          rows[0].createdAt,
        ).toBeTruthy();
      },
    );

    it(
      'creates both quota indexes with the exact names and column order',
      async () => {
        await runPrincipalBaseline();

        await new AddAgentTemplateSendQuota1788868800000().up(
          queryRunner,
        );

        const usageTable =
          await queryRunner.getTable(
            USAGE_TABLE,
          );

        expect(
          usageTable,
        ).toBeDefined();

        const consumedIndex =
          usageTable?.indices.find(
            index =>
              index.name ===
              CONSUMED_INDEX,
          );

        const reservationIndex =
          usageTable?.indices.find(
            index =>
              index.name ===
              RESERVATION_INDEX,
          );

        expect(
          consumedIndex?.columnNames,
        ).toEqual([
          'agentId',
          'status',
          'consumedAt',
        ]);

        expect(
          consumedIndex?.isUnique,
        ).toBe(
          false,
        );

        expect(
          reservationIndex?.columnNames,
        ).toEqual([
          'agentId',
          'status',
          'reservationExpiresAt',
        ]);

        expect(
          reservationIndex?.isUnique,
        ).toBe(
          false,
        );
      },
    );

    it(
      'creates an Agent cascade foreign key but deliberately no Session foreign key',
      async () => {
        await runPrincipalBaseline();

        await new AddAgentTemplateSendQuota1788868800000().up(
          queryRunner,
        );

        const usageTable =
          await queryRunner.getTable(
            USAGE_TABLE,
          );

        expect(
          usageTable,
        ).toBeDefined();

        const agentForeignKey =
          usageTable?.foreignKeys.find(
            foreignKey =>
              foreignKey.columnNames.length ===
                1 &&
              foreignKey.columnNames[0] ===
                'agentId',
          );

        expect(
          agentForeignKey,
        ).toBeDefined();

        expect(
          agentForeignKey?.referencedTableName,
        ).toBe(
          'agents',
        );

        expect(
          agentForeignKey?.referencedColumnNames,
        ).toEqual([
          'id',
        ]);

        expect(
          agentForeignKey?.onDelete?.toUpperCase(),
        ).toBe(
          'CASCADE',
        );

        expect(
          usageTable?.foreignKeys.some(
            foreignKey =>
              foreignKey.columnNames.includes(
                'sessionId',
              ),
          ),
        ).toBe(
          false,
        );
      },
    );

    it(
      'cascades usage rows when an Agent is deleted',
      async () => {
        await runPrincipalBaseline();

        const { agentId } =
          await insertExistingAgent();

        await new AddAgentTemplateSendQuota1788868800000().up(
          queryRunner,
        );

        await queryRunner.query(
          `INSERT INTO "${USAGE_TABLE}" ` +
            `("id", "agentId", "sessionId", "status", "consumedAt") ` +
            `VALUES (?, ?, ?, ?, ?)`,
          [
            'usage-consumed-1',
            agentId,
            'session-1',
            'consumed',
            '2026-09-08 12:00:00',
          ],
        );

        const beforeDelete =
          (await queryRunner.query(
            `SELECT COUNT(*) AS "count" ` +
              `FROM "${USAGE_TABLE}" ` +
              `WHERE "agentId" = ?`,
            [agentId],
          )) as Array<{
            count: number;
          }>;

        expect(
          Number(
            beforeDelete[0].count,
          ),
        ).toBe(
          1,
        );

        await queryRunner.query(
          `DELETE FROM "agents" ` +
            `WHERE "id" = ?`,
          [agentId],
        );

        const afterDelete =
          (await queryRunner.query(
            `SELECT COUNT(*) AS "count" ` +
              `FROM "${USAGE_TABLE}" ` +
              `WHERE "agentId" = ?`,
            [agentId],
          )) as Array<{
            count: number;
          }>;

        expect(
          Number(
            afterDelete[0].count,
          ),
        ).toBe(
          0,
        );
      },
    );

    it(
      'accepts 0 as a persisted quota value rather than conflating it with NULL',
      async () => {
        await runPrincipalBaseline();

        const { agentId } =
          await insertExistingAgent();

        await new AddAgentTemplateSendQuota1788868800000().up(
          queryRunner,
        );

        await queryRunner.query(
          `UPDATE "agents" ` +
            `SET "templateSendLimit24h" = ? ` +
            `WHERE "id" = ?`,
          [
            0,
            agentId,
          ],
        );

        const rows =
          (await queryRunner.query(
            `SELECT "templateSendLimit24h" ` +
              `FROM "agents" ` +
              `WHERE "id" = ?`,
            [agentId],
          )) as Array<{
            templateSendLimit24h:
              number | null;
          }>;

        expect(
          rows[0].templateSendLimit24h,
        ).toBe(
          0,
        );
      },
    );

    it(
      'is idempotent when up() is run more than once',
      async () => {
        await runPrincipalBaseline();

        const migration =
          new AddAgentTemplateSendQuota1788868800000();

        await migration.up(
          queryRunner,
        );

        await expect(
          migration.up(
            queryRunner,
          ),
        ).resolves.not.toThrow();

        const agentsTable =
          await queryRunner.getTable(
            'agents',
          );

        expect(
          agentsTable?.columns.filter(
            column =>
              column.name ===
              'templateSendLimit24h',
          ),
        ).toHaveLength(
          1,
        );

        const usageTable =
          await queryRunner.getTable(
            USAGE_TABLE,
          );

        expect(
          usageTable?.indices.filter(
            index =>
              index.name ===
              CONSUMED_INDEX,
          ),
        ).toHaveLength(
          1,
        );

        expect(
          usageTable?.indices.filter(
            index =>
              index.name ===
              RESERVATION_INDEX,
          ),
        ).toHaveLength(
          1,
        );

        const tables =
          (await queryRunner.query(
            `SELECT "name" ` +
              `FROM "sqlite_master" ` +
              `WHERE "type" = 'table' ` +
              `AND "name" = ?`,
            [USAGE_TABLE],
          )) as Array<{
            name: string;
          }>;

        expect(
          tables,
        ).toHaveLength(
          1,
        );
      },
    );

    it(
      'down() removes only quota schema and preserves the existing Agent principal schema and data',
      async () => {
        await runPrincipalBaseline();

        const {
          teamLeaderId,
          agentId,
        } =
          await insertExistingAgent({
            assignedSessionId:
              'session-existing',
          });

        const migration =
          new AddAgentTemplateSendQuota1788868800000();

        await migration.up(
          queryRunner,
        );

        await queryRunner.query(
          `UPDATE "agents" ` +
            `SET "templateSendLimit24h" = ? ` +
            `WHERE "id" = ?`,
          [
            25,
            agentId,
          ],
        );

        await queryRunner.query(
          `INSERT INTO "${USAGE_TABLE}" ` +
            `("id", "agentId", "sessionId") ` +
            `VALUES (?, ?, ?)`,
          [
            'usage-before-down',
            agentId,
            'session-existing',
          ],
        );

        await migration.down(
          queryRunner,
        );

        expect(
          await queryRunner.hasTable(
            USAGE_TABLE,
          ),
        ).toBe(
          false,
        );

        expect(
          await queryRunner.hasTable(
            'agents',
          ),
        ).toBe(
          true,
        );

        expect(
          await queryRunner.hasColumn(
            'agents',
            'templateSendLimit24h',
          ),
        ).toBe(
          false,
        );

        const rows =
          (await queryRunner.query(
            `SELECT ` +
              `"id", ` +
              `"name", ` +
              `"email", ` +
              `"teamLeaderId", ` +
              `"assignedSessionId" ` +
              `FROM "agents" ` +
              `WHERE "id" = ?`,
            [agentId],
          )) as Array<{
            id: string;
            name: string;
            email: string | null;
            teamLeaderId: string;
            assignedSessionId: string | null;
          }>;

        expect(
          rows,
        ).toEqual([
          {
            id: agentId,
            name: 'Mohamed Ali',
            email:
              'mohamed@example.com',
            teamLeaderId,
            assignedSessionId:
              'session-existing',
          },
        ]);

        const agentsTable =
          await queryRunner.getTable(
            'agents',
          );

        const teamLeaderForeignKey =
          agentsTable?.foreignKeys.find(
            foreignKey =>
              foreignKey.columnNames.length ===
                1 &&
              foreignKey.columnNames[0] ===
                'teamLeaderId' &&
              foreignKey.referencedTableName ===
                'team_leaders',
          );

        expect(
          teamLeaderForeignKey,
        ).toBeDefined();

        expect(
          teamLeaderForeignKey?.onDelete?.toUpperCase(),
        ).toBe(
          'CASCADE',
        );

        expect(
          agentsTable?.indices.some(
            index =>
              index.columnNames.length ===
                1 &&
              index.columnNames[0] ===
                'teamLeaderId',
          ),
        ).toBe(
          true,
        );

        expect(
          agentsTable?.indices.some(
            index =>
              index.columnNames.length ===
                1 &&
              index.columnNames[0] ===
                'assignedSessionId',
          ),
        ).toBe(
          true,
        );
      },
    );
  },
);




