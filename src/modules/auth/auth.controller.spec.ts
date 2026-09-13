





import 'reflect-metadata';

import type { Request } from 'express';

import {
  AuditAction,
} from '../audit/entities/audit-log.entity';
import type {
  AuditService,
} from '../audit/audit.service';

import {
  AuthController,
} from './auth.controller';
import type {
  AuthService,
} from './auth.service';
import {
  UNSCOPED_KEY,
} from './decorators/auth.decorators';
import {
  ApiKeyRole,
  type ApiKey,
} from './entities/api-key.entity';

function createApiKey(
  overrides: Partial<ApiKey> = {},
): ApiKey {
  return {
    id: 'k1',

    name:
      'target-key',

    keyHash:
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',

    keyPrefix:
      'owa_k1_targe',

    role:
      ApiKeyRole.VIEWER,

    teamLeaderId:
      null,

    teamLeader:
      null,

    agentId:
      null,

    agent:
      null,

    allowedIps:
      null,

    allowedSessions:
      null,

    isActive:
      true,

    expiresAt:
      null,

    lastUsedAt:
      null,

    usageCount:
      0,

    createdAt:
      new Date(
        '2026-01-01T00:00:00Z',
      ),

    updatedAt:
      new Date(
        '2026-01-01T00:00:00Z',
      ),

    ...overrides,
  };
}

/**
 * Key-lifecycle routes carry no session dimension, so the guard's
 * allowedSessions fence cannot constrain them.
 *
 * The class-level @RequireUnscopedKey marker prevents a session-scoped
 * ADMIN key from minting or widening credentials through this controller.
 */
describe(
  'AuthController — scoped-key confinement marker',
  () => {
    it(
      'requires unscoped keys at the class level',
      () => {
        expect(
          Reflect.getMetadata(
            UNSCOPED_KEY,
            AuthController,
          ),
        ).toBe(true);
      },
    );
  },
);

describe(
  'AuthController — API-key lifecycle',
  () => {
    const actor =
      createApiKey({
        id:
          'admin-key',

        name:
          'admin',

        role:
          ApiKeyRole.ADMIN,
      });

    const makeReq =
      (): Request =>
        ({
          method:
            'POST',

          path:
            '/auth/api-keys',

          clientIp:
            '203.0.113.7',
        }) as unknown as Request;

    let authService: {
      createApiKey:
        jest.Mock;

      reissueApiKey:
        jest.Mock;

      findAll:
        jest.Mock;

      findOne:
        jest.Mock;

      update:
        jest.Mock;

      delete:
        jest.Mock;

      revoke:
        jest.Mock;
    };

    let auditService: {
      logInfo:
        jest.Mock;
    };

    let controller:
      AuthController;

    beforeEach(() => {
      const createdKey =
        createApiKey({
          id:
            'k1',

          name:
            'new-key',

          role:
            ApiKeyRole.OPERATOR,
        });

      authService = {
        createApiKey:
          jest
            .fn()
            .mockResolvedValue({
              apiKey:
                createdKey,

              rawKey:
                'raw-secret',
            }),

        reissueApiKey:
          jest
            .fn()
            .mockResolvedValue({
              apiKey:
                createApiKey({
                  id:
                    'k1',

                  name:
                    'target-key',

                  role:
                    ApiKeyRole.VIEWER,
                }),

              rawKey:
                'reissued-raw-secret',
            }),

        findAll:
          jest
            .fn()
            .mockResolvedValue([
              createdKey,
            ]),

        findOne:
          jest
            .fn()
            .mockResolvedValue(
              createApiKey({
                id:
                  'k1',

                name:
                  'target-key',

                role:
                  ApiKeyRole.VIEWER,
              }),
            ),

        update:
          jest
            .fn()
            .mockResolvedValue(
              createApiKey({
                id:
                  'k1',

                name:
                  'target-key',

                role:
                  ApiKeyRole.ADMIN,
              }),
            ),

        delete:
          jest
            .fn()
            .mockResolvedValue(
              undefined,
            ),

        revoke:
          jest
            .fn()
            .mockResolvedValue(
              createApiKey({
                id:
                  'k1',

                name:
                  'target-key',

                role:
                  ApiKeyRole.VIEWER,

                isActive:
                  false,
              }),
            ),
      };

      auditService = {
        logInfo:
          jest
            .fn()
            .mockResolvedValue(
              null,
            ),
      };

      controller =
        new AuthController(
          authService as unknown as AuthService,
          auditService as unknown as AuditService,
        );
    });

    const lastContextFor = (
      action: AuditAction,
    ):
      | {
          apiKey?:
            ApiKey;

          ipAddress?:
            string;

          metadata?: {
            targetKeyId?:
              string;

            action?:
              string;

            role?:
              ApiKeyRole;

            teamLeaderId?:
              string | null;

            agentId?:
              string | null;

            before?: {
              role?:
                ApiKeyRole;
            };

            after?: {
              role?:
                ApiKeyRole;
            };
          };
        }
      | undefined => {
      const calls =
        auditService
          .logInfo
          .mock
          .calls as Array<
          [
            AuditAction,
            {
              apiKey?:
                ApiKey;

              ipAddress?:
                string;

              metadata?: {
                targetKeyId?:
                  string;

                action?:
                  string;

                role?:
                  ApiKeyRole;

                teamLeaderId?:
                  string | null;

                agentId?:
                  string | null;

                before?: {
                  role?:
                    ApiKeyRole;
                };

                after?: {
                  role?:
                    ApiKeyRole;
                };
              };
            },
          ]
        >;

      return calls.find(
        call =>
          call[0] ===
          action,
      )?.[1];
    };

    it(
      'logs API_KEY_CREATED on create with the acting key, IP, and target id without auditing plaintext',
      async () => {
        const result =
          await controller.create(
            {
              name:
                'new-key',
            },

            makeReq(),

            actor,
          );

        const context =
          lastContextFor(
            AuditAction.API_KEY_CREATED,
          );

        expect(
          context,
        ).toBeDefined();

        expect(
          context?.apiKey,
        ).toBe(
          actor,
        );

        expect(
          context?.ipAddress,
        ).toBe(
          '203.0.113.7',
        );

        expect(
          context
            ?.metadata
            ?.targetKeyId,
        ).toBe(
          'k1',
        );

        expect(
          result.apiKey,
        ).toBe(
          'raw-secret',
        );

        expect(
          result.teamLeaderId,
        ).toBeNull();

        expect(
          result.agentId,
        ).toBeNull();

        /**
         * The raw credential may be returned to the caller once, but must
         * never be copied into the audit log.
         */
        expect(
          JSON.stringify(
            auditService
              .logInfo
              .mock
              .calls,
          ),
        ).not.toContain(
          'raw-secret',
        );
      },
    );

    it(
      'includes Team Leader and Agent principal binding ids in list responses',
      async () => {
        authService
          .findAll
          .mockResolvedValue([
            createApiKey({
              id:
                'tl-key',

              role:
                ApiKeyRole.TEAM_LEADER,

              teamLeaderId:
                'tl-1',
            }),

            createApiKey({
              id:
                'agent-key',

              role:
                ApiKeyRole.AGENT,

              agentId:
                'agent-1',
            }),
          ]);

        const result =
          await controller.findAll();

        expect(
          result,
        ).toEqual([
          expect.objectContaining({
            id:
              'tl-key',

            teamLeaderId:
              'tl-1',

            agentId:
              null,
          }),

          expect.objectContaining({
            id:
              'agent-key',

            teamLeaderId:
              null,

            agentId:
              'agent-1',
          }),
        ]);
      },
    );

    it(
      'includes principal binding ids in a single-key response',
      async () => {
        authService
          .findOne
          .mockResolvedValue(
            createApiKey({
              id:
                'agent-key',

              role:
                ApiKeyRole.AGENT,

              agentId:
                'agent-1',
            }),
          );

        await expect(
          controller.findOne(
            'agent-key',
          ),
        ).resolves.toEqual(
          expect.objectContaining({
            id:
              'agent-key',

            teamLeaderId:
              null,

            agentId:
              'agent-1',
          }),
        );
      },
    );

    it(
      'reissues an API key, returns the replacement plaintext once, and audits without the secret',
      async () => {
        const result =
          await controller.reissue(
            'k1',
            makeReq(),
            actor,
          );

        expect(
          authService.reissueApiKey,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          authService.reissueApiKey,
        ).toHaveBeenCalledWith(
          'k1',
        );

        expect(
          result,
        ).toEqual(
          expect.objectContaining({
            id:
              'k1',

            apiKey:
              'reissued-raw-secret',
          }),
        );

        const context =
          lastContextFor(
            AuditAction.API_KEY_UPDATED,
          );

        expect(
          context?.apiKey,
        ).toBe(
          actor,
        );

        expect(
          context
            ?.metadata
            ?.targetKeyId,
        ).toBe(
          'k1',
        );

        expect(
          context
            ?.metadata
            ?.action,
        ).toBe(
          'reissue',
        );

        expect(
          JSON.stringify(
            auditService
              .logInfo
              .mock
              .calls,
          ),
        ).not.toContain(
          'reissued-raw-secret',
        );
      },
    );

    it(
      'preserves principal binding ids in the reissue response and audit metadata',
      async () => {
        authService
          .reissueApiKey
          .mockResolvedValue({
            apiKey:
              createApiKey({
                id:
                  'agent-key',

                name:
                  'Agent key',

                role:
                  ApiKeyRole.AGENT,

                agentId:
                  'agent-1',
              }),

            rawKey:
              'replacement-agent-secret',
          });

        const result =
          await controller.reissue(
            'agent-key',
            makeReq(),
            actor,
          );

        expect(
          result.agentId,
        ).toBe(
          'agent-1',
        );

        expect(
          result.teamLeaderId,
        ).toBeNull();

        const context =
          lastContextFor(
            AuditAction.API_KEY_UPDATED,
          );

        expect(
          context
            ?.metadata
            ?.agentId,
        ).toBe(
          'agent-1',
        );

        expect(
          context
            ?.metadata
            ?.teamLeaderId,
        ).toBeNull();
      },
    );

    it(
      'logs API_KEY_DELETED on delete',
      async () => {
        await controller.delete(
          'k1',
          makeReq(),
          actor,
        );

        expect(
          authService.delete,
        ).toHaveBeenCalledWith(
          'k1',
        );

        expect(
          lastContextFor(
            AuditAction.API_KEY_DELETED,
          )
            ?.metadata
            ?.targetKeyId,
        ).toBe(
          'k1',
        );
      },
    );

    it(
      'logs API_KEY_UPDATED with before/after authorization state',
      async () => {
        await controller.update(
          'k1',

          {
            role:
              ApiKeyRole.ADMIN,
          },

          makeReq(),

          actor,
        );

        const context =
          lastContextFor(
            AuditAction.API_KEY_UPDATED,
          );

        expect(
          context?.apiKey,
        ).toBe(
          actor,
        );

        expect(
          context
            ?.metadata
            ?.targetKeyId,
        ).toBe(
          'k1',
        );

        expect(
          context
            ?.metadata
            ?.before
            ?.role,
        ).toBe(
          ApiKeyRole.VIEWER,
        );

        expect(
          context
            ?.metadata
            ?.after
            ?.role,
        ).toBe(
          ApiKeyRole.ADMIN,
        );
      },
    );

    it(
      'returns principal binding ids after update',
      async () => {
        authService
          .update
          .mockResolvedValue(
            createApiKey({
              id:
                'tl-key',

              role:
                ApiKeyRole.TEAM_LEADER,

              teamLeaderId:
                'tl-1',
            }),
          );

        const result =
          await controller.update(
            'tl-key',

            {
              name:
                'renamed',
            },

            makeReq(),

            actor,
          );

        expect(
          result.teamLeaderId,
        ).toBe(
          'tl-1',
        );

        expect(
          result.agentId,
        ).toBeNull();
      },
    );

    it(
      'logs API_KEY_REVOKED on revoke and returns principal binding ids',
      async () => {
        authService
          .revoke
          .mockResolvedValue(
            createApiKey({
              id:
                'agent-key',

              role:
                ApiKeyRole.AGENT,

              agentId:
                'agent-1',

              isActive:
                false,
            }),
          );

        const result =
          await controller.revoke(
            'agent-key',
            makeReq(),
            actor,
          );

        expect(
          lastContextFor(
            AuditAction.API_KEY_REVOKED,
          )
            ?.metadata
            ?.targetKeyId,
        ).toBe(
          'agent-key',
        );

        expect(
          result.agentId,
        ).toBe(
          'agent-1',
        );

        expect(
          result.teamLeaderId,
        ).toBeNull();

        expect(
          result.isActive,
        ).toBe(
          false,
        );
      },
    );
  },
);





