


import { z } from 'zod';

import { ApiCapability } from '../../../modules/auth/capabilities/api-capability';

import type { ChatState } from '../../../engine/interfaces/whatsapp-engine.interface';

import type { SessionService } from '../../../modules/session/session.service';

import { SessionResponseDto } from '../../../modules/session/dto/session-response.dto';

import {
  defineTool,
  type AnyToolDescriptor,
} from '../tool-descriptor';

const sessionId = z
  .string()
  .min(1)
  .describe(
    'Session UUID (the session id, not the name)',
  );

export function sessionTools(
  session: SessionService,
): AnyToolDescriptor[] {
  return [
    defineTool({
      name: 'SessionFindAll',

      description:
        'List the WhatsApp sessions this API key may access (id, name, status). ' +
        'Use to discover available sessions before calling session-scoped tools. ' +
        'Supports limit/offset paging.',

      tier: 'read',

      /*
       * Phase J:
       *
       * Listing sessions is an aggregate operation. The invoker resolves the
       * authenticated principal's effective SessionScope and supplies it in
       * context.sessionScope.
       */
      requiredCapability:
        ApiCapability.SESSION_READ,

      aggregateSessionScoped: true,

      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional(),

        offset: z
          .number()
          .int()
          .min(0)
          .optional(),
      }),

      handler: (
        input,
        _apiKey,
        context,
      ) => {
        if (!context.sessionScope) {
          throw new Error(
            'SessionFindAll requires resolved session scope',
          );
        }

        return session
          .findAll(
            context.sessionScope,
            {
              limit: input.limit,
              offset: input.offset,
            },
          )
          .then(sessions =>
            sessions.map(sessionEntity =>
              SessionResponseDto.fromEntity(
                sessionEntity,
              ),
            ),
          );
      },
    }),

    defineTool({
      name: 'SessionFindOne',

      description:
        'Get one session by its UUID, including connection status and phone number.',

      tier: 'read',

      requiredCapability:
        ApiCapability.SESSION_READ,

      /*
       * invokeTool() will call:
       *
       * SessionTenantAccessService.assertSessionAccess(apiKey, sessionId)
       *
       * before executing this handler.
       */
      sessionScoped: true,

      inputSchema: z.object({
        sessionId,
      }),

      handler: input =>
        session
          .findOne(
            input.sessionId,
          )
          .then(sessionEntity =>
            SessionResponseDto.fromEntity(
              sessionEntity,
            ),
          ),
    }),

    defineTool({
      name: 'SessionGetChats',

      description:
        'List recent chats for a session (most recent first). ' +
        'Use limit/offset to page through large lists.',

      tier: 'read',

      /*
       * Reading chats is different from merely reading Session metadata.
       */
      requiredCapability:
        ApiCapability.CHAT_READ,

      sessionScoped: true,

      inputSchema: z.object({
        sessionId,

        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional(),

        offset: z
          .number()
          .int()
          .min(0)
          .optional(),
      }),

      handler: input =>
        session.getChats(
          input.sessionId,
          {
            limit: input.limit,
            offset: input.offset,
          },
        ),
    }),

    defineTool({
      name: 'SessionGetStats',

      description:
        'Aggregate session counts (total, active, ready, disconnected) ' +
        'for the sessions this API key may access.',

      tier: 'read',

      requiredCapability:
        ApiCapability.SESSION_READ,

      /*
       * This is an aggregate/global tool rather than a single-session tool.
       */
      aggregateSessionScoped: true,

      inputSchema: z.object({}),

      handler: (
        _input,
        _apiKey,
        context,
      ) => {
        if (!context.sessionScope) {
          throw new Error(
            'SessionGetStats requires resolved session scope',
          );
        }

        return session.getStats(
          context.sessionScope,
        );
      },
    }),

    defineTool({
      name: 'SessionMarkChatRead',

      description:
        'Mark a chat as read (clears unread count).',

      tier: 'write',

      /*
       * Agent is allowed to perform approved chat operations.
       *
       * Role-based OPERATOR gating would incorrectly reject an Agent that
       * legitimately holds CHAT_OPERATE.
       */
      requiredCapability:
        ApiCapability.CHAT_OPERATE,

      sessionScoped: true,

      inputSchema: z.object({
        sessionId,

        chatId: z
          .string()
          .describe(
            'Chat JID (e.g. 1234567890@c.us)',
          ),
      }),

      handler: input =>
        session
          .sendSeen(
            input.sessionId,
            input.chatId,
          )
          .then(success => ({
            success,
          })),
    }),

    defineTool({
      name: 'SessionMarkChatUnread',

      description:
        'Mark a chat as unread.',

      tier: 'write',

      requiredCapability:
        ApiCapability.CHAT_OPERATE,

      sessionScoped: true,

      inputSchema: z.object({
        sessionId,

        chatId: z
          .string()
          .describe(
            'Chat JID (e.g. 1234567890@c.us)',
          ),
      }),

      handler: input =>
        session
          .markUnread(
            input.sessionId,
            input.chatId,
          )
          .then(success => ({
            success,
          })),
    }),

    defineTool({
      name: 'SessionSendChatState',

      description:
        "Show a typing/recording indicator in a chat, or clear it with 'paused'.",

      tier: 'write',

      requiredCapability:
        ApiCapability.CHAT_OPERATE,

      sessionScoped: true,

      inputSchema: z.object({
        sessionId,

        chatId: z
          .string()
          .describe(
            'Chat JID (e.g. 1234567890@c.us)',
          ),

        state: z
          .enum([
            'typing',
            'recording',
            'paused',
          ])
          .describe(
            "'typing' or 'recording' shows the indicator; 'paused' clears it",
          ),
      }),

      handler: input =>
        session
          .sendChatState(
            input.sessionId,
            input.chatId,
            input.state as ChatState,
          )
          .then(() => ({
            success: true,
          })),
    }),
  ];
}

