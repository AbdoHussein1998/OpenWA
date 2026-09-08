






import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';

import {
  SessionTenantAccessService,
} from './session-tenant-access.service';

import {
  SessionScopeType,
} from './session-scope';

import {
  ApiKey,
  ApiKeyRole,
} from '../auth/entities/api-key.entity';

import {
  Agent,
} from '../teamleader/entities/agent.entity';

import {
  Session,
  SessionStatus,
} from '../session/entities/session.entity';

/**
 * SessionTenantAccessService is the central tenant policy.
 *
 * These tests deliberately verify both:
 *
 *   WHAT effective scope is produced
 *
 * and:
 *
 *   whether a concrete session may actually be accessed.
 *
 * Core security invariant:
 *
 *   tenant / principal scope
 *          INTERSECT
 *   allowedSessions when non-empty
 *
 * For Agents:
 *
 *   Session.id === Agent.assignedSessionId
 *
 * AND
 *
 *   Session.ownerTeamLeaderId === Agent.teamLeaderId
 *
 * AND
 *
 *   allowedSessions contains the assignment when allowedSessions
 *   is non-empty.
 */

function createApiKey(
  overrides: Partial<ApiKey> = {},
): ApiKey {
  return {
    id:
      'api-key-1',

    name:
      'Test API Key',

    keyHash:
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',

    keyPrefix:
      'owa_k1_test1',

    role:
      ApiKeyRole.ADMIN,

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
  } as ApiKey;
}

function createAgent(
  overrides: Partial<Agent> = {},
): Agent {
  return {
    id:
      'agent-1',

    name:
      'Mohamed Ali',

    email:
      'mohamed@example.com',

    teamLeaderId:
      'team-leader-a',

    teamLeader:
      {} as Agent['teamLeader'],

    assignedSessionId:
      'session-a',

    templateSendLimit24h:
      null,

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

function createSession(
  overrides: Partial<Session> = {},
): Session {
  return {
    id:
      'session-a',

    name:
      'Session A',

    ownerTeamLeaderId:
      'team-leader-a',

    status:
      SessionStatus.CREATED,

    phone:
      null,

    targetPhone:
      null,

    pushName:
      null,

    config:
      {},

    proxyUrl:
      null,

    proxyType:
      null,

    connectedAt:
      null,

    lastActiveAt:
      null,

    nodeId:
      null,

    claimedAt:
      null,

    nodeUrl:
      null,

    leaseExpiresAt:
      null,

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

describe(
  'SessionTenantAccessService',
  () => {
    let service:
      SessionTenantAccessService;

    let agentRepository: {
      findOne: jest.Mock;
    };

    let sessionRepository: {
      findOne: jest.Mock;
    };

    beforeEach(() => {
      agentRepository = {
        findOne:
          jest.fn(),
      };

      sessionRepository = {
        findOne:
          jest.fn(),
      };

      service =
        new SessionTenantAccessService(
          agentRepository as unknown as Repository<Agent>,

          sessionRepository as unknown as Repository<Session>,
        );
    });

    // -------------------------------------------------------------------------
    // Legacy roles
    // -------------------------------------------------------------------------

    describe(
      'getEffectiveSessionScope — legacy roles',
      () => {
        it.each([
          ApiKeyRole.ADMIN,
          ApiKeyRole.OPERATOR,
          ApiKeyRole.VIEWER,
        ])(
          '%s without allowedSessions resolves to ALL',
          async role => {
            const apiKey =
              createApiKey({
                role,

                allowedSessions:
                  null,
              });

            await expect(
              service.getEffectiveSessionScope(
                apiKey,
              ),
            ).resolves.toEqual({
              type:
                SessionScopeType.ALL,
            });

            expect(
              agentRepository.findOne,
            ).not.toHaveBeenCalled();
          },
        );

        it.each([
          ApiKeyRole.ADMIN,
          ApiKeyRole.OPERATOR,
          ApiKeyRole.VIEWER,
        ])(
          '%s with allowedSessions resolves to IDS',
          async role => {
            const apiKey =
              createApiKey({
                role,

                allowedSessions: [
                  'session-a',
                  'session-b',
                ],
              });

            await expect(
              service.getEffectiveSessionScope(
                apiKey,
              ),
            ).resolves.toEqual({
              type:
                SessionScopeType.IDS,

              sessionIds: [
                'session-a',
                'session-b',
              ],
            });
          },
        );

        it(
          'treats an empty allowedSessions array as no additional ceiling',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.OPERATOR,

                allowedSessions:
                  [],
              });

            await expect(
              service.getEffectiveSessionScope(
                apiKey,
              ),
            ).resolves.toEqual({
              type:
                SessionScopeType.ALL,
            });
          },
        );

        it(
          'normalizes duplicate and empty allowedSessions entries',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.OPERATOR,

                allowedSessions: [
                  'session-a',
                  '',
                  'session-a',
                  'session-b',
                ],
              });

            await expect(
              service.getEffectiveSessionScope(
                apiKey,
              ),
            ).resolves.toEqual({
              type:
                SessionScopeType.IDS,

              sessionIds: [
                'session-a',
                'session-b',
              ],
            });
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // Team Leader scope
    // -------------------------------------------------------------------------

    describe(
      'getEffectiveSessionScope — Team Leader',
      () => {
        it(
          'without allowedSessions resolves to OWNER(teamLeaderId)',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.TEAM_LEADER,

                teamLeaderId:
                  'team-leader-a',

                allowedSessions:
                  null,
              });

            await expect(
              service.getEffectiveSessionScope(
                apiKey,
              ),
            ).resolves.toEqual({
              type:
                SessionScopeType.OWNER,

              ownerTeamLeaderId:
                'team-leader-a',
            });
          },
        );

        it(
          'with allowedSessions resolves to OWNER_AND_IDS',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.TEAM_LEADER,

                teamLeaderId:
                  'team-leader-a',

                allowedSessions: [
                  'session-a',
                  'session-c',
                ],
              });

            await expect(
              service.getEffectiveSessionScope(
                apiKey,
              ),
            ).resolves.toEqual({
              type:
                SessionScopeType.OWNER_AND_IDS,

              ownerTeamLeaderId:
                'team-leader-a',

              sessionIds: [
                'session-a',
                'session-c',
              ],
            });
          },
        );

        it(
          'treats allowedSessions as a ceiling rather than replacing ownership',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.TEAM_LEADER,

                teamLeaderId:
                  'team-leader-a',

                allowedSessions: [
                  'session-owned-by-b',
                ],
              });

            const scope =
              await service.getEffectiveSessionScope(
                apiKey,
              );

            expect(
              scope,
            ).toEqual({
              type:
                SessionScopeType.OWNER_AND_IDS,

              ownerTeamLeaderId:
                'team-leader-a',

              sessionIds: [
                'session-owned-by-b',
              ],
            });

            /**
             * This does NOT mean session-owned-by-b is accessible.
             *
             * Concrete access must still satisfy:
             *
             * ownerTeamLeaderId = team-leader-a
             * AND
             * id IN allowedSessions.
             */
          },
        );

        it(
          'fails closed when a TEAM_LEADER key has no teamLeaderId binding',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.TEAM_LEADER,

                teamLeaderId:
                  null,
              });

            await expect(
              service.getEffectiveSessionScope(
                apiKey,
              ),
            ).rejects.toBeInstanceOf(
              ForbiddenException,
            );
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // Agent scope
    // -------------------------------------------------------------------------

    describe(
      'getEffectiveSessionScope — Agent',
      () => {
        it(
          'uses Agent.assignedSessionId as the explicit session restriction',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.AGENT,

                agentId:
                  'agent-1',

                allowedSessions:
                  null,
              });

            agentRepository.findOne
              .mockResolvedValue(
                createAgent({
                  id:
                    'agent-1',

                  teamLeaderId:
                    'team-leader-a',

                  assignedSessionId:
                    'session-a',
                }),
              );

            const scope =
              await service.getEffectiveSessionScope(
                apiKey,
              );

            expect(
              agentRepository.findOne,
            ).toHaveBeenCalledWith({
              where: {
                id:
                  'agent-1',
              },
            });

            expect(
              scope,
            ).toEqual({
              type:
                SessionScopeType.OWNER_AND_IDS,

              ownerTeamLeaderId:
                'team-leader-a',

              sessionIds: [
                'session-a',
              ],
            });
          },
        );

        it(
          'preserves ownerTeamLeaderId together with assignedSessionId',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.AGENT,

                agentId:
                  'agent-1',
              });

            agentRepository.findOne
              .mockResolvedValue(
                createAgent({
                  teamLeaderId:
                    'team-leader-b',

                  assignedSessionId:
                    'session-x',
                }),
              );

            await expect(
              service.getEffectiveSessionScope(
                apiKey,
              ),
            ).resolves.toEqual({
              type:
                SessionScopeType.OWNER_AND_IDS,

              ownerTeamLeaderId:
                'team-leader-b',

              sessionIds: [
                'session-x',
              ],
            });
          },
        );


        it(
          'does not use templateSendLimit24h as part of session authorization',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.AGENT,

                agentId:
                  'agent-1',
              });

            agentRepository.findOne
              .mockResolvedValue(
                createAgent({
                  teamLeaderId:
                    'team-leader-a',

                  assignedSessionId:
                    'session-a',

                  templateSendLimit24h:
                    0,
                }),
              );

            await expect(
              service.getEffectiveSessionScope(
                apiKey,
              ),
            ).resolves.toEqual({
              type:
                SessionScopeType.OWNER_AND_IDS,

              ownerTeamLeaderId:
                'team-leader-a',

              sessionIds: [
                'session-a',
              ],
            });
          },
        );

        it(
          'returns NONE when the Agent is unassigned',
          async () => {
            agentRepository.findOne
              .mockResolvedValue(
                createAgent({
                  assignedSessionId:
                    null,
                }),
              );

            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.AGENT,

                agentId:
                  'agent-1',
              });

            await expect(
              service.getEffectiveSessionScope(
                apiKey,
              ),
            ).resolves.toEqual({
              type:
                SessionScopeType.NONE,
            });
          },
        );

        it(
          'allows the assigned session when allowedSessions contains that assignment',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.AGENT,

                agentId:
                  'agent-1',

                allowedSessions: [
                  'session-other',
                  'session-a',
                ],
              });

            agentRepository.findOne
              .mockResolvedValue(
                createAgent({
                  teamLeaderId:
                    'team-leader-a',

                  assignedSessionId:
                    'session-a',
                }),
              );

            /**
             * Even though allowedSessions contains two IDs, the Agent
             * still gets only the single assigned session.
             */
            await expect(
              service.getEffectiveSessionScope(
                apiKey,
              ),
            ).resolves.toEqual({
              type:
                SessionScopeType.OWNER_AND_IDS,

              ownerTeamLeaderId:
                'team-leader-a',

              sessionIds: [
                'session-a',
              ],
            });
          },
        );

        it(
          'returns NONE when allowedSessions excludes assignedSessionId',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.AGENT,

                agentId:
                  'agent-1',

                allowedSessions: [
                  'session-b',
                ],
              });

            agentRepository.findOne
              .mockResolvedValue(
                createAgent({
                  teamLeaderId:
                    'team-leader-a',

                  assignedSessionId:
                    'session-a',
                }),
              );

            await expect(
              service.getEffectiveSessionScope(
                apiKey,
              ),
            ).resolves.toEqual({
              type:
                SessionScopeType.NONE,
            });
          },
        );

        it(
          'does not widen Agent access merely because allowedSessions contains more sessions',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.AGENT,

                agentId:
                  'agent-1',

                allowedSessions: [
                  'session-a',
                  'session-b',
                  'session-c',
                ],
              });

            agentRepository.findOne
              .mockResolvedValue(
                createAgent({
                  assignedSessionId:
                    'session-b',

                  teamLeaderId:
                    'team-leader-a',
                }),
              );

            await expect(
              service.getEffectiveSessionScope(
                apiKey,
              ),
            ).resolves.toEqual({
              type:
                SessionScopeType.OWNER_AND_IDS,

              ownerTeamLeaderId:
                'team-leader-a',

              sessionIds: [
                'session-b',
              ],
            });
          },
        );

        it(
          'fails closed when an AGENT key has no agentId binding',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.AGENT,

                agentId:
                  null,
              });

            await expect(
              service.getEffectiveSessionScope(
                apiKey,
              ),
            ).rejects.toBeInstanceOf(
              ForbiddenException,
            );

            expect(
              agentRepository.findOne,
            ).not.toHaveBeenCalled();
          },
        );

        it(
          'fails closed when the bound Agent principal no longer exists',
          async () => {
            agentRepository.findOne
              .mockResolvedValue(
                null,
              );

            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.AGENT,

                agentId:
                  'missing-agent',
              });

            await expect(
              service.getEffectiveSessionScope(
                apiKey,
              ),
            ).rejects.toBeInstanceOf(
              ForbiddenException,
            );
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // assertSessionAccess — ALL
    // -------------------------------------------------------------------------

    describe(
      'assertSessionAccess — ALL',
      () => {
        it(
          'allows an unscoped legacy identity to access an existing session',
          async () => {
            const session =
              createSession({
                id:
                  'session-any',
              });

            sessionRepository.findOne
              .mockResolvedValue(
                session,
              );

            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.ADMIN,

                allowedSessions:
                  null,
              });

            const result =
              await service.assertSessionAccess(
                apiKey,
                'session-any',
              );

            expect(
              sessionRepository.findOne,
            ).toHaveBeenCalledWith({
              where: {
                id:
                  'session-any',
              },
            });

            expect(
              result,
            ).toBe(
              session,
            );
          },
        );

        it(
          'returns 404 for a nonexistent session',
          async () => {
            sessionRepository.findOne
              .mockResolvedValue(
                null,
              );

            await expect(
              service.assertSessionAccess(
                createApiKey({
                  role:
                    ApiKeyRole.ADMIN,
                }),

                'missing-session',
              ),
            ).rejects.toBeInstanceOf(
              NotFoundException,
            );
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // assertSessionAccess — IDS
    // -------------------------------------------------------------------------

    describe(
      'assertSessionAccess — IDS ceiling',
      () => {
        it(
          'allows a legacy scoped key to access an ID inside allowedSessions',
          async () => {
            const session =
              createSession({
                id:
                  'session-a',
              });

            sessionRepository.findOne
              .mockResolvedValue(
                session,
              );

            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.OPERATOR,

                allowedSessions: [
                  'session-a',
                  'session-b',
                ],
              });

            await expect(
              service.assertSessionAccess(
                apiKey,
                'session-a',
              ),
            ).resolves.toBe(
              session,
            );
          },
        );

        it(
          'returns 404 when the requested ID is outside allowedSessions',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.OPERATOR,

                allowedSessions: [
                  'session-a',
                ],
              });

            await expect(
              service.assertSessionAccess(
                apiKey,
                'session-b',
              ),
            ).rejects.toBeInstanceOf(
              NotFoundException,
            );

            /**
             * ID ceiling can reject before touching the Session table.
             */
            expect(
              sessionRepository.findOne,
            ).not.toHaveBeenCalled();
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // assertSessionAccess — OWNER
    // -------------------------------------------------------------------------

    describe(
      'assertSessionAccess — Team Leader OWNER',
      () => {
        it(
          'allows a Team Leader to access a session they own',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.TEAM_LEADER,

                teamLeaderId:
                  'team-leader-a',
              });

            const session =
              createSession({
                id:
                  'session-a',

                ownerTeamLeaderId:
                  'team-leader-a',
              });

            sessionRepository.findOne
              .mockResolvedValue(
                session,
              );

            await expect(
              service.assertSessionAccess(
                apiKey,
                'session-a',
              ),
            ).resolves.toBe(
              session,
            );
          },
        );

        it(
          'returns 404 when the session is owned by another Team Leader',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.TEAM_LEADER,

                teamLeaderId:
                  'team-leader-a',
              });

            sessionRepository.findOne
              .mockResolvedValue(
                createSession({
                  id:
                    'session-b',

                  ownerTeamLeaderId:
                    'team-leader-b',
                }),
              );

            const promise =
              service.assertSessionAccess(
                apiKey,
                'session-b',
              );

            await expect(
              promise,
            ).rejects.toBeInstanceOf(
              NotFoundException,
            );

            await expect(
              promise,
            ).rejects.toMatchObject({
              message:
                'Session not found',
            });
          },
        );

        it(
          'does not allow a Team Leader to access a legacy owner-null session',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.TEAM_LEADER,

                teamLeaderId:
                  'team-leader-a',
              });

            sessionRepository.findOne
              .mockResolvedValue(
                createSession({
                  ownerTeamLeaderId:
                    null,
                }),
              );

            await expect(
              service.assertSessionAccess(
                apiKey,
                'legacy-session',
              ),
            ).rejects.toBeInstanceOf(
              NotFoundException,
            );
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // assertSessionAccess — OWNER_AND_IDS
    // -------------------------------------------------------------------------

    describe(
      'assertSessionAccess — OWNER_AND_IDS intersection',
      () => {
        it(
          'allows an Agent only when assignedSessionId AND ownerTeamLeaderId both match',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.AGENT,

                agentId:
                  'agent-1',
              });

            agentRepository.findOne
              .mockResolvedValue(
                createAgent({
                  id:
                    'agent-1',

                  teamLeaderId:
                    'team-leader-a',

                  assignedSessionId:
                    'session-a',
                }),
              );

            const session =
              createSession({
                id:
                  'session-a',

                ownerTeamLeaderId:
                  'team-leader-a',
              });

            sessionRepository.findOne
              .mockResolvedValue(
                session,
              );

            await expect(
              service.assertSessionAccess(
                apiKey,
                'session-a',
              ),
            ).resolves.toBe(
              session,
            );
          },
        );

        it(
          'denies an Agent when requested session differs from assignedSessionId',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.AGENT,

                agentId:
                  'agent-1',
              });

            agentRepository.findOne
              .mockResolvedValue(
                createAgent({
                  teamLeaderId:
                    'team-leader-a',

                  assignedSessionId:
                    'session-a',
                }),
              );

            await expect(
              service.assertSessionAccess(
                apiKey,
                'session-b',
              ),
            ).rejects.toBeInstanceOf(
              NotFoundException,
            );

            /**
             * Explicit assignment ceiling rejects before loading the
             * foreign session.
             */
            expect(
              sessionRepository.findOne,
            ).not.toHaveBeenCalled();
          },
        );

        it(
          'denies a corrupt cross-tenant Agent assignment even when assignedSessionId matches',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.AGENT,

                agentId:
                  'agent-a',
              });

            /**
             * Agent A belongs to Team Leader A and is assigned
             * session-b.
             */
            agentRepository.findOne
              .mockResolvedValue(
                createAgent({
                  id:
                    'agent-a',

                  teamLeaderId:
                    'team-leader-a',

                  assignedSessionId:
                    'session-b',
                }),
              );

            /**
             * But session-b belongs to Team Leader B.
             *
             * assignedSessionId alone MUST NOT authorize this.
             */
            sessionRepository.findOne
              .mockResolvedValue(
                createSession({
                  id:
                    'session-b',

                  ownerTeamLeaderId:
                    'team-leader-b',
                }),
              );

            await expect(
              service.assertSessionAccess(
                apiKey,
                'session-b',
              ),
            ).rejects.toBeInstanceOf(
              NotFoundException,
            );

            expect(
              sessionRepository.findOne,
            ).toHaveBeenCalledWith({
              where: {
                id:
                  'session-b',
              },
            });
          },
        );

        it(
          'denies an Agent when allowedSessions excludes the assigned session',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.AGENT,

                agentId:
                  'agent-1',

                allowedSessions: [
                  'session-b',
                ],
              });

            agentRepository.findOne
              .mockResolvedValue(
                createAgent({
                  teamLeaderId:
                    'team-leader-a',

                  assignedSessionId:
                    'session-a',
                }),
              );

            await expect(
              service.assertSessionAccess(
                apiKey,
                'session-a',
              ),
            ).rejects.toBeInstanceOf(
              NotFoundException,
            );

            /**
             * Effective Agent scope became NONE, so no session lookup
             * is required.
             */
            expect(
              sessionRepository.findOne,
            ).not.toHaveBeenCalled();
          },
        );

        it(
          'allows an Agent when allowedSessions contains the assignment and ownership also matches',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.AGENT,

                agentId:
                  'agent-1',

                allowedSessions: [
                  'some-other-session',
                  'session-a',
                ],
              });

            agentRepository.findOne
              .mockResolvedValue(
                createAgent({
                  teamLeaderId:
                    'team-leader-a',

                  assignedSessionId:
                    'session-a',
                }),
              );

            const session =
              createSession({
                id:
                  'session-a',

                ownerTeamLeaderId:
                  'team-leader-a',
              });

            sessionRepository.findOne
              .mockResolvedValue(
                session,
              );

            await expect(
              service.assertSessionAccess(
                apiKey,
                'session-a',
              ),
            ).resolves.toBe(
              session,
            );
          },
        );

        it(
          'denies a Team Leader session that is owned but outside allowedSessions',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.TEAM_LEADER,

                teamLeaderId:
                  'team-leader-a',

                allowedSessions: [
                  'session-a',
                ],
              });

            await expect(
              service.assertSessionAccess(
                apiKey,
                'session-b',
              ),
            ).rejects.toBeInstanceOf(
              NotFoundException,
            );

            /**
             * allowedSessions is a hard ceiling even though the
             * requested session might otherwise be tenant-owned.
             */
            expect(
              sessionRepository.findOne,
            ).not.toHaveBeenCalled();
          },
        );

        it(
          'denies a Team Leader session that is inside allowedSessions but owned by another tenant',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.TEAM_LEADER,

                teamLeaderId:
                  'team-leader-a',

                allowedSessions: [
                  'session-b',
                ],
              });

            sessionRepository.findOne
              .mockResolvedValue(
                createSession({
                  id:
                    'session-b',

                  ownerTeamLeaderId:
                    'team-leader-b',
                }),
              );

            await expect(
              service.assertSessionAccess(
                apiKey,
                'session-b',
              ),
            ).rejects.toBeInstanceOf(
              NotFoundException,
            );
          },
        );

        it(
          'allows a Team Leader only when ownership and allowedSessions both match',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.TEAM_LEADER,

                teamLeaderId:
                  'team-leader-a',

                allowedSessions: [
                  'session-a',
                  'session-c',
                ],
              });

            const session =
              createSession({
                id:
                  'session-a',

                ownerTeamLeaderId:
                  'team-leader-a',
              });

            sessionRepository.findOne
              .mockResolvedValue(
                session,
              );

            await expect(
              service.assertSessionAccess(
                apiKey,
                'session-a',
              ),
            ).resolves.toBe(
              session,
            );
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // NONE
    // -------------------------------------------------------------------------

    describe(
      'assertSessionAccess — NONE',
      () => {
        it(
          'denies every session for an unassigned Agent',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.AGENT,

                agentId:
                  'agent-1',
              });

            agentRepository.findOne
              .mockResolvedValue(
                createAgent({
                  assignedSessionId:
                    null,
                }),
              );

            await expect(
              service.assertSessionAccess(
                apiKey,
                'session-a',
              ),
            ).rejects.toBeInstanceOf(
              NotFoundException,
            );

            expect(
              sessionRepository.findOne,
            ).not.toHaveBeenCalled();
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // Tenant-denial information hiding
    // -------------------------------------------------------------------------

    describe(
      'tenant-denial semantics',
      () => {
        it(
          'uses the same 404 message for a nonexistent session',
          async () => {
            sessionRepository.findOne
              .mockResolvedValue(
                null,
              );

            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.ADMIN,
              });

            await expect(
              service.assertSessionAccess(
                apiKey,
                'missing-session',
              ),
            ).rejects.toMatchObject({
              status:
                404,

              message:
                'Session not found',
            });
          },
        );

        it(
          'uses the same 404 message for a foreign Team Leader session',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.TEAM_LEADER,

                teamLeaderId:
                  'team-leader-a',
              });

            sessionRepository.findOne
              .mockResolvedValue(
                createSession({
                  id:
                    'session-b',

                  ownerTeamLeaderId:
                    'team-leader-b',
                }),
              );

            await expect(
              service.assertSessionAccess(
                apiKey,
                'session-b',
              ),
            ).rejects.toMatchObject({
              status:
                404,

              message:
                'Session not found',
            });
          },
        );

        it(
          'uses the same 404 message when allowedSessions denies the ID',
          async () => {
            const apiKey =
              createApiKey({
                role:
                  ApiKeyRole.OPERATOR,

                allowedSessions: [
                  'session-a',
                ],
              });

            await expect(
              service.assertSessionAccess(
                apiKey,
                'session-b',
              ),
            ).rejects.toMatchObject({
              status:
                404,

              message:
                'Session not found',
            });
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // hasGlobalSessionAccess()
    // -------------------------------------------------------------------------

    describe(
      'hasGlobalSessionAccess',
      () => {
        it(
          'returns true for an unscoped ADMIN',
          async () => {
            await expect(
              service.hasGlobalSessionAccess(
                createApiKey({
                  role:
                    ApiKeyRole.ADMIN,

                  allowedSessions:
                    null,
                }),
              ),
            ).resolves.toBe(
              true,
            );
          },
        );

        it(
          'returns true for an unscoped legacy OPERATOR',
          async () => {
            await expect(
              service.hasGlobalSessionAccess(
                createApiKey({
                  role:
                    ApiKeyRole.OPERATOR,

                  allowedSessions:
                    null,
                }),
              ),
            ).resolves.toBe(
              true,
            );
          },
        );

        it(
          'returns false for a scoped legacy key',
          async () => {
            await expect(
              service.hasGlobalSessionAccess(
                createApiKey({
                  role:
                    ApiKeyRole.ADMIN,

                  allowedSessions: [
                    'session-a',
                  ],
                }),
              ),
            ).resolves.toBe(
              false,
            );
          },
        );

        it(
          'returns false for a Team Leader even without allowedSessions',
          async () => {
            await expect(
              service.hasGlobalSessionAccess(
                createApiKey({
                  role:
                    ApiKeyRole.TEAM_LEADER,

                  teamLeaderId:
                    'team-leader-a',

                  allowedSessions:
                    null,
                }),
              ),
            ).resolves.toBe(
              false,
            );
          },
        );

        it(
          'returns false for an assigned Agent',
          async () => {
            agentRepository.findOne
              .mockResolvedValue(
                createAgent({
                  assignedSessionId:
                    'session-a',
                }),
              );

            await expect(
              service.hasGlobalSessionAccess(
                createApiKey({
                  role:
                    ApiKeyRole.AGENT,

                  agentId:
                    'agent-1',
                }),
              ),
            ).resolves.toBe(
              false,
            );
          },
        );

        it(
          'returns false for an unassigned Agent',
          async () => {
            agentRepository.findOne
              .mockResolvedValue(
                createAgent({
                  assignedSessionId:
                    null,
                }),
              );

            await expect(
              service.hasGlobalSessionAccess(
                createApiKey({
                  role:
                    ApiKeyRole.AGENT,

                  agentId:
                    'agent-1',
                }),
              ),
            ).resolves.toBe(
              false,
            );
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // Unknown / malformed role
    // -------------------------------------------------------------------------

    describe(
      'fail-closed behavior',
      () => {
        it(
          'rejects an unsupported database role',
          async () => {
            const apiKey =
              createApiKey();

            /**
             * Deliberately simulate corrupt/unrecognized persisted data.
             */
            (
              apiKey as {
                role: string;
              }
            ).role =
              'unknown_role';

            await expect(
              service.getEffectiveSessionScope(
                apiKey,
              ),
            ).rejects.toBeInstanceOf(
              ForbiddenException,
            );
          },
        );
      },
    );
  },
);






