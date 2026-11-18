

import {
  allAgentTools,
} from './tools';

import {
  z,
} from 'zod';

import type {
  AnyToolDescriptor,
} from './tool-descriptor';

import {
  ApiCapability,
} from '../../modules/auth/capabilities/api-capability';


describe(
  'agent-tool registry: session tenancy invariants',
  () => {
    /*
     * Handlers are never invoked in these registry checks.
     *
     * We only inspect descriptor metadata and input schemas, so stub services
     * are sufficient.
     */
    const allTools:
      AnyToolDescriptor[] = [
        ...allAgentTools(
          {} as never,
        ),
      ];

    const sessionScoped =
      allTools.filter(
        tool =>
          tool.sessionScoped ===
          true,
      );

    const aggregateSessionScoped =
      allTools.filter(
        tool =>
          tool.aggregateSessionScoped ===
          true,
      );

    const getTool = (
      name:
        string,
    ): AnyToolDescriptor => {
      const tool =
        allTools.find(
          candidate =>
            candidate.name ===
            name,
        );

      if (!tool) {
        throw new Error(
          `Expected agent tool '${name}' to be registered`,
        );
      }

      return tool;
    };

    it(
      'has sessionScoped tools to check (the guard is meaningful)',
      () => {
        expect(
          sessionScoped.length,
        ).toBeGreaterThan(
          0,
        );
      },
    );

    /*
     * The dangerous direction:
     *
     * a descriptor accepts sessionId but forgets sessionScoped.
     *
     * In that case invokeTool would not call assertSessionAccess().
     */
    it(
      'marks every tool that takes a sessionId as sessionScoped',
      () => {
        const takesSessionId =
          allTools.filter(
            tool => {
              const shape =
                (
                  tool.inputSchema as unknown as z.ZodObject<
                    Record<
                      string,
                      z.ZodType
                    >
                  >
                ).shape;

              return (
                shape != null &&
                'sessionId' in
                  shape
              );
            },
          );

        /*
         * Guard the guard: a broken shape probe must not silently make this
         * invariant vacuous.
         */
        expect(
          takesSessionId.length,
        ).toBeGreaterThan(
          0,
        );

        expect(
          takesSessionId
            .filter(
              tool =>
                tool.sessionScoped !==
                true,
            )
            .map(
              tool =>
                tool.name,
            ),
        ).toEqual(
          [],
        );
      },
    );

    it.each(
      sessionScoped.map(
        tool =>
          [
            tool.name,
            tool,
          ] as const,
      ),
    )(
      '%s rejects a missing and an empty sessionId',
      (
        _name,
        tool,
      ) => {
        /*
         * Isolate sessionId so another required field cannot hide a weakened
         * sessionId schema.
         */
        const shape =
          (
            tool.inputSchema as unknown as z.ZodObject<{
              sessionId:
                z.ZodType;
            }>
          ).shape;

        const sessionIdSchema:
          z.ZodType =
            shape.sessionId;

        expect(
          sessionIdSchema,
        ).toBeDefined();

        expect(
          sessionIdSchema.safeParse(
            undefined,
          ).success,
        ).toBe(
          false,
        );

        expect(
          sessionIdSchema.safeParse(
            '',
          ).success,
        ).toBe(
          false,
        );
      },
    );

    /*
     * Phase J:
     *
     * Single-session and aggregate scope modes have fundamentally different
     * authorization paths and must never be enabled simultaneously.
     */
    it(
      'never marks a tool as both sessionScoped and aggregateSessionScoped',
      () => {
        const invalid =
          allTools
            .filter(
              tool =>
                tool.sessionScoped ===
                  true &&
                tool.aggregateSessionScoped ===
                  true,
            )
            .map(
              tool =>
                tool.name,
            );

        expect(
          invalid,
        ).toEqual(
          [],
        );
      },
    );

    it(
      'has aggregate session-scoped tools to check',
      () => {
        expect(
          aggregateSessionScoped.length,
        ).toBeGreaterThan(
          0,
        );
      },
    );

    /*
     * Aggregate/global tools are especially dangerous because their handlers
     * can query across multiple sessions.
     *
     * They must always have an explicit capability gate.
     */
    it(
      'requires an explicit capability on every aggregate session-scoped tool',
      () => {
        const missingCapability =
          aggregateSessionScoped
            .filter(
              tool =>
                !tool.requiredCapability,
            )
            .map(
              tool =>
                tool.name,
            );

        expect(
          missingCapability,
        ).toEqual(
          [],
        );
      },
    );

    /*
     * These are the aggregate MCP tools converted during Phase J.
     *
     * Use arrayContaining rather than exact equality so adding another
     * correctly-scoped aggregate tool in the future does not require changing
     * this test.
     */
    it(
      'marks Phase J aggregate session/webhook tools as aggregateSessionScoped',
      () => {
        const aggregateNames =
          aggregateSessionScoped.map(
            tool =>
              tool.name,
          );

        expect(
          aggregateNames,
        ).toEqual(
          expect.arrayContaining([
            'SessionFindAll',
            'SessionGetStats',
            'WebhooksList',
          ]),
        );

        for (
          const name of [
            'SessionFindAll',
            'SessionGetStats',
            'WebhooksList',
          ]
        ) {
          const tool =
            getTool(
              name,
            );

          expect(
            tool.aggregateSessionScoped,
          ).toBe(
            true,
          );

          expect(
            tool.sessionScoped,
          ).not.toBe(
            true,
          );
        }
      },
    );

    /*
     * Phase J removes role-based MCP authorization from these descriptors.
     *
     * Keeping requiredRole here would reintroduce the exact bug that prevents
     * an AGENT with a valid capability from using approved tools.
     */
    it(
      'uses capabilities rather than requiredRole for Phase J session and webhook tools',
      () => {
        const phaseJToolNames = [
          'SessionFindAll',
          'SessionFindOne',
          'SessionGetChats',
          'SessionGetStats',
          'SessionMarkChatRead',
          'SessionMarkChatUnread',
          'SessionSendChatState',

          'WebhooksList',
          'WebhookFindBySession',
          'WebhookFindOne',
        ];

        const stillRoleBased =
          phaseJToolNames
            .map(
              name =>
                getTool(
                  name,
                ),
            )
            .filter(
              tool =>
                tool.requiredRole !==
                undefined,
            )
            .map(
              tool =>
                tool.name,
            );

        expect(
          stillRoleBased,
        ).toEqual(
          [],
        );
      },
    );

    it(
      'uses the expected capabilities for session tools',
      () => {
        expect(
          getTool(
            'SessionFindAll',
          ).requiredCapability,
        ).toBe(
          ApiCapability.SESSION_READ,
        );

        expect(
          getTool(
            'SessionFindOne',
          ).requiredCapability,
        ).toBe(
          ApiCapability.SESSION_READ,
        );

        expect(
          getTool(
            'SessionGetStats',
          ).requiredCapability,
        ).toBe(
          ApiCapability.SESSION_READ,
        );

        expect(
          getTool(
            'SessionGetChats',
          ).requiredCapability,
        ).toBe(
          ApiCapability.CHAT_READ,
        );

        expect(
          getTool(
            'SessionMarkChatRead',
          ).requiredCapability,
        ).toBe(
          ApiCapability.CHAT_OPERATE,
        );

        expect(
          getTool(
            'SessionMarkChatUnread',
          ).requiredCapability,
        ).toBe(
          ApiCapability.CHAT_OPERATE,
        );

        expect(
          getTool(
            'SessionSendChatState',
          ).requiredCapability,
        ).toBe(
          ApiCapability.CHAT_OPERATE,
        );
      },
    );

    it(
      'keeps webhook MCP tools behind WEBHOOK_MANAGE',
      () => {
        for (
          const name of [
            'WebhooksList',
            'WebhookFindBySession',
            'WebhookFindOne',
          ]
        ) {
          expect(
            getTool(
              name,
            ).requiredCapability,
          ).toBe(
            ApiCapability.WEBHOOK_MANAGE,
          );
        }
      },
    );
  },
);


