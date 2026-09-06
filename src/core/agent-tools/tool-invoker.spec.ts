



import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { z } from 'zod';

import type { AuthService } from '../../modules/auth/auth.service';

import {
  ApiKeyRole,
  type ApiKey,
} from '../../modules/auth/entities/api-key.entity';

import { ApiCapability } from '../../modules/auth/capabilities/api-capability';

import type { SessionTenantAccessService } from '../../modules/access-control/session-tenant-access.service';

import {
  SessionScopeType,
  type SessionScope,
} from '../../modules/access-control/session-scope';

import {
  defineTool,
} from './tool-descriptor';

import {
  invokeTool,
} from './tool-invoker';


describe('invokeTool — Phase J MCP tenancy', () => {
  let authService: AuthService;

  let sessionTenantAccessService:
    SessionTenantAccessService;

  let validateApiKey:
    jest.Mock;

  let hasCapability:
    jest.Mock;

  let hasPermission:
    jest.Mock;

  let assertSessionAccess:
    jest.Mock;

  let getEffectiveSessionScope:
    jest.Mock;

  const teamLeaderA = {
    id: 'key-team-leader-a',
    name: 'Team Leader A',
    role: ApiKeyRole.TEAM_LEADER,
    teamLeaderId: 'team-leader-a',

    /*
     * Deliberately present so these tests prove MCP does not authorize
     * directly from this property.
     */
    allowedSessions: [
      'legacy-ceiling-session',
    ],
  } as ApiKey;

  const agentA = {
    id: 'key-agent-a',
    name: 'Agent A',
    role: ApiKeyRole.AGENT,
    teamLeaderId: 'team-leader-a',
    agentId: 'agent-a',

    allowedSessions: [
      'session-a',
    ],
  } as ApiKey;

  beforeEach(() => {
    validateApiKey =
      jest.fn();

    hasCapability =
      jest.fn();

    hasPermission =
      jest.fn();

    assertSessionAccess =
      jest.fn();

    getEffectiveSessionScope =
      jest.fn();

    authService = {
      validateApiKey,
      hasCapability,
      hasPermission,
    } as unknown as AuthService;

    sessionTenantAccessService = {
      assertSessionAccess,
      getEffectiveSessionScope,
    } as unknown as SessionTenantAccessService;
  });

  function createSessionReadTool() {
    const handler =
      jest.fn(
        async (
          input: {
            sessionId: string;
          },
        ) => ({
          sessionId:
            input.sessionId,
        }),
      );

    const tool =
      defineTool({
        name:
          'TestSessionRead',

        description:
          'Test session-scoped read tool',

        tier:
          'read',

        requiredCapability:
          ApiCapability.SESSION_READ,

        sessionScoped:
          true,

        inputSchema:
          z.object({
            sessionId:
              z
                .string()
                .min(1),
          }),

        handler: async input =>
          handler(
            input,
          ),
      });

    return {
      tool,
      handler,
    };
  }

  it.each([
    [
      'TEAM_LEADER',
      teamLeaderA,
    ],
    [
      'AGENT',
      agentA,
    ],
  ])(
    '%s may invoke a session-scoped tool when SessionTenantAccessService allows the session',
    async (
      _principal,
      apiKey,
    ) => {
      validateApiKey
        .mockResolvedValue(
          apiKey,
        );

      hasCapability
        .mockReturnValue(
          true,
        );

      assertSessionAccess
        .mockResolvedValue(
          undefined,
        );

      const {
        tool,
        handler,
      } =
        createSessionReadTool();

      const result =
        await invokeTool(
          tool,
          {
            sessionId:
              'session-a',
          },
          'raw-api-key',
          authService,
          sessionTenantAccessService,
        );

      expect(
        validateApiKey,
      ).toHaveBeenCalledWith(
        'raw-api-key',
        undefined,
      );

      expect(
        hasCapability,
      ).toHaveBeenCalledWith(
        apiKey,
        ApiCapability.SESSION_READ,
      );

      expect(
        assertSessionAccess,
      ).toHaveBeenCalledTimes(
        1,
      );

      expect(
        assertSessionAccess,
      ).toHaveBeenCalledWith(
        apiKey,
        'session-a',
      );

      expect(
        handler,
      ).toHaveBeenCalledTimes(
        1,
      );

      expect(
        result,
      ).toEqual({
        sessionId:
          'session-a',
      });
    },
  );

  it.each([
    [
      'TEAM_LEADER',
      teamLeaderA,
    ],
    [
      'AGENT',
      agentA,
    ],
  ])(
    '%s receives a 404-equivalent denial for a foreign session and the handler never runs',
    async (
      _principal,
      apiKey,
    ) => {
      validateApiKey
        .mockResolvedValue(
          apiKey,
        );

      hasCapability
        .mockReturnValue(
          true,
        );

      assertSessionAccess
        .mockRejectedValue(
          new NotFoundException(
            'Session not found',
          ),
        );

      const {
        tool,
        handler,
      } =
        createSessionReadTool();

      await expect(
        invokeTool(
          tool,
          {
            sessionId:
              'session-b',
          },
          'raw-api-key',
          authService,
          sessionTenantAccessService,
        ),
      ).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(
        assertSessionAccess,
      ).toHaveBeenCalledWith(
        apiKey,
        'session-b',
      );

      /*
       * Most important part of the foreign-tenant test:
       *
       * the service handler must never run after tenant denial.
       */
      expect(
        handler,
      ).not.toHaveBeenCalled();
    },
  );

  it(
    'denies an AGENT before tenant lookup when the tool requires a capability the Agent does not have',
    async () => {
      validateApiKey
        .mockResolvedValue(
          agentA,
        );

      hasCapability
        .mockReturnValue(
          false,
        );

      const handler =
        jest.fn(
          async () => ({
            ok: true,
          }),
        );

      const tool =
        defineTool({
          name:
            'SessionStartLikeTool',

          description:
            'Represents a session-management operation',

          tier:
            'write',

          requiredCapability:
            ApiCapability.SESSION_MANAGE,

          sessionScoped:
            true,

          inputSchema:
            z.object({
              sessionId:
                z
                  .string()
                  .min(1),
            }),

          handler: async input =>
            handler(
              input,
            ),
        });

      await expect(
        invokeTool(
          tool,
          {
            sessionId:
              'session-a',
          },
          'raw-agent-key',
          authService,
          sessionTenantAccessService,
        ),
      ).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      expect(
        hasCapability,
      ).toHaveBeenCalledWith(
        agentA,
        ApiCapability.SESSION_MANAGE,
      );

      /*
       * WHAT authorization fails before WHERE authorization.
       */
      expect(
        assertSessionAccess,
      ).not.toHaveBeenCalled();

      expect(
        getEffectiveSessionScope,
      ).not.toHaveBeenCalled();

      expect(
        handler,
      ).not.toHaveBeenCalled();
    },
  );

  it.each<{
    label: string;
    apiKey: ApiKey;
    scope: SessionScope;
  }>([
    {
      label:
        'TEAM_LEADER',

      apiKey:
        teamLeaderA,

      scope: {
        type:
          SessionScopeType.OWNER,

        ownerTeamLeaderId:
          'team-leader-a',
      },
    },

    {
      label:
        'AGENT',

      apiKey:
        agentA,

      scope: {
        type:
          SessionScopeType.OWNER_AND_IDS,

        ownerTeamLeaderId:
          'team-leader-a',

        sessionIds: [
          'session-a',
        ],
      },
    },
  ])(
    '$label aggregate tool receives the effective SessionScope from SessionTenantAccessService',
    async ({
      apiKey,
      scope,
    }) => {
      validateApiKey
        .mockResolvedValue(
          apiKey,
        );

      hasCapability
        .mockReturnValue(
          true,
        );

      getEffectiveSessionScope
        .mockResolvedValue(
          scope,
        );

      const handler =
        jest.fn(
          async (
            _input: Record<
              string,
              never
            >,
            _authenticatedKey:
              ApiKey,
            context: {
              sessionScope?:
                SessionScope;
            },
          ) =>
            context.sessionScope,
        );

      const tool =
        defineTool({
          name:
            'AggregateSessions',

          description:
            'Test aggregate session tool',

          tier:
            'read',

          requiredCapability:
            ApiCapability.SESSION_READ,

          aggregateSessionScoped:
            true,

          inputSchema:
            z.object({}),

          handler,
        });

      const result =
        await invokeTool(
          tool,
          {},
          'raw-api-key',
          authService,
          sessionTenantAccessService,
        );

      expect(
        getEffectiveSessionScope,
      ).toHaveBeenCalledTimes(
        1,
      );

      expect(
        getEffectiveSessionScope,
      ).toHaveBeenCalledWith(
        apiKey,
      );

      /*
       * Aggregate tools do NOT perform one-session authorization.
       */
      expect(
        assertSessionAccess,
      ).not.toHaveBeenCalled();

      expect(
        handler,
      ).toHaveBeenCalledTimes(
        1,
      );

      expect(
        handler.mock.calls[0][2],
      ).toEqual({
        sessionScope:
          scope,
      });

      expect(
        result,
      ).toEqual(
        scope,
      );
    },
  );

  it(
    'uses effective aggregate scope instead of raw apiKey.allowedSessions',
    async () => {
      const agentWithMisleadingLegacyCeiling =
        {
          ...agentA,

          allowedSessions: [
            'foreign-session',
          ],
        } as ApiKey;

      const effectiveScope:
        SessionScope = {
          type:
            SessionScopeType.OWNER_AND_IDS,

          ownerTeamLeaderId:
            'team-leader-a',

          sessionIds: [
            'session-a',
          ],
        };

      validateApiKey
        .mockResolvedValue(
          agentWithMisleadingLegacyCeiling,
        );

      hasCapability
        .mockReturnValue(
          true,
        );

      getEffectiveSessionScope
        .mockResolvedValue(
          effectiveScope,
        );

      const handler =
        jest.fn(
          async (
            _input,
            _apiKey,
            context,
          ) =>
            context.sessionScope,
        );

      const tool =
        defineTool({
          name:
            'AggregateScopeCeilingTest',

          description:
            'Aggregate tenant-scope test',

          tier:
            'read',

          requiredCapability:
            ApiCapability.SESSION_READ,

          aggregateSessionScoped:
            true,

          inputSchema:
            z.object({}),

          handler,
        });

      const result =
        await invokeTool(
          tool,
          {},
          'raw-api-key',
          authService,
          sessionTenantAccessService,
        );

      expect(
        result,
      ).toEqual(
        effectiveScope,
      );

      expect(
        result,
      ).not.toEqual({
        type:
          SessionScopeType.IDS,

        sessionIds: [
          'foreign-session',
        ],
      });
    },
  );
});


