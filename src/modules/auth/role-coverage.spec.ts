


import { AuthService } from './auth.service';

import {
  ApiKey,
  ApiKeyRole,
} from './entities/api-key.entity';

import {
  ApiCapability,
} from './capabilities/api-capability';

describe('AuthService capability matrix — TEAM_LEADER / AGENT', () => {
  /*
   * hasCapability() is pure authorization logic.
   *
   * Constructing through the prototype keeps this focused test independent
   * from repositories, hashing, audit, WebSocket eviction, etc.
   *
   * If your existing role-coverage.spec.ts already creates AuthService through
   * Nest TestingModule, simply use that instance instead.
   */
  const authService =
    Object.create(
      AuthService.prototype,
    ) as AuthService;

  const teamLeader = {
    id: 'key-team-leader-a',
    name: 'Team Leader A',
    role: ApiKeyRole.TEAM_LEADER,
    teamLeaderId: 'team-leader-a',
  } as ApiKey;

  const agent = {
    id: 'key-agent-a',
    name: 'Agent A',
    role: ApiKeyRole.AGENT,
    teamLeaderId: 'team-leader-a',
    agentId: 'agent-a',
  } as ApiKey;

  type CapabilityCase = {
    capability: ApiCapability;
    teamLeader: boolean;
    agent: boolean;
  };

  const matrix: CapabilityCase[] = [
    {
      capability:
        ApiCapability.SESSION_READ,

      teamLeader:
        true,

      agent:
        true,
    },

    {
      capability:
        ApiCapability.CHAT_READ,

      teamLeader:
        true,

      agent:
        true,
    },

    {
      capability:
        ApiCapability.CHAT_OPERATE,

      teamLeader:
        true,

      agent:
        true,
    },

    {
      capability:
        ApiCapability.SESSION_MANAGE,

      /*
       * Team Leaders own/manage sessions, but tenant checks still restrict
       * those operations to sessions they own.
       */
      teamLeader:
        true,

      /*
       * Agents may operate approved chat/message actions but may not manage
       * session lifecycle.
       */
      agent:
        false,
    },

    {
      capability:
        ApiCapability.WEBHOOK_MANAGE,

      /*
       * Webhook management is intentionally restricted to the roles that
       * AuthService grants WEBHOOK_MANAGE (currently ADMIN / OPERATOR).
       *
       * TEAM_LEADER still has tenant-scoped session/message/template powers,
       * but webhook configuration is outside its capability set.
       */
      teamLeader:
        false,

      /*
       * Explicitly excluded from the Agent capability set as well.
       */
      agent:
        false,
    },
  ];

  describe.each([
    {
      principal:
        'TEAM_LEADER',

      apiKey:
        teamLeader,

      expectedKey:
        'teamLeader' as const,
    },

    {
      principal:
        'AGENT',

      apiKey:
        agent,

      expectedKey:
        'agent' as const,
    },
  ])(
    '$principal',
    ({
      apiKey,
      expectedKey,
    }) => {
      it.each(
        matrix.map(
          entry => [
            entry.capability,
            entry[
              expectedKey
            ],
          ] as const,
        ),
      )(
        '%s -> %s',
        (
          capability,
          expected,
        ) => {
          expect(
            authService.hasCapability(
              apiKey,
              capability,
            ),
          ).toBe(
            expected,
          );
        },
      );
    },
  );

  it(
    'keeps the focused TEAM_LEADER / AGENT capability boundary explicit',
    () => {
      const actual = Object.fromEntries(
        matrix.map(
          ({
            capability,
          }) => [
            capability,
            {
              teamLeader:
                authService.hasCapability(
                  teamLeader,
                  capability,
                ),

              agent:
                authService.hasCapability(
                  agent,
                  capability,
                ),
            },
          ],
        ),
      );

      expect(
        actual,
      ).toEqual({
        [ApiCapability.SESSION_READ]: {
          teamLeader: true,
          agent: true,
        },

        [ApiCapability.CHAT_READ]: {
          teamLeader: true,
          agent: true,
        },

        [ApiCapability.CHAT_OPERATE]: {
          teamLeader: true,
          agent: true,
        },

        [ApiCapability.SESSION_MANAGE]: {
          teamLeader: true,
          agent: false,
        },

        [ApiCapability.WEBHOOK_MANAGE]: {
          teamLeader: false,
          agent: false,
        },
      });
    },
  );
});



