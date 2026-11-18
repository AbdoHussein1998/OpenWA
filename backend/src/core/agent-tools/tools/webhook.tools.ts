


import { z } from 'zod';

import { ApiCapability } from '../../../modules/auth/capabilities/api-capability';

import type { WebhookService } from '../../../modules/webhook/webhook.service';

import { WebhookResponseDto } from '../../../modules/webhook/dto/webhook.dto';

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

export function webhookTools(
  webhook: WebhookService,
): AnyToolDescriptor[] {
  return [
    defineTool({
      name: 'WebhooksList',

      description:
        'List all webhooks the API key is allowed to see across its accessible sessions. ' +
        'Supports limit/offset paging.',

      tier: 'read',

      /*
       * The capability model currently treats webhook access as a management
       * capability. Agents deliberately do not receive WEBHOOK_MANAGE.
       */
      requiredCapability:
        ApiCapability.WEBHOOK_MANAGE,

      /*
       * Global/aggregate endpoint.
       *
       * Never use apiKey.allowedSessions here because it cannot represent:
       *
       * OWNER
       * OWNER_AND_IDS
       * NONE
       */
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
            'WebhooksList requires resolved session scope',
          );
        }

        return webhook
          .findAll(
            context.sessionScope,
            {
              limit: input.limit,
              offset: input.offset,
            },
          )
          .then(webhooks =>
            WebhookResponseDto.fromEntities(
              webhooks,
            ),
          );
      },
    }),

    defineTool({
      name: 'WebhookFindBySession',

      description:
        'List all webhooks registered for a specific session.',

      tier: 'read',

      requiredCapability:
        ApiCapability.WEBHOOK_MANAGE,

      /*
       * invokeTool() performs the tenant check before this handler.
       */
      sessionScoped: true,

      inputSchema: z.object({
        sessionId,
      }),

      handler: input =>
        webhook
          .findBySession(
            input.sessionId,
          )
          .then(webhooks =>
            WebhookResponseDto.fromEntities(
              webhooks,
            ),
          ),
    }),

    defineTool({
      name: 'WebhookFindOne',

      description:
        'Get details for a specific webhook by ID within a session.',

      tier: 'read',

      requiredCapability:
        ApiCapability.WEBHOOK_MANAGE,

      sessionScoped: true,

      inputSchema: z.object({
        sessionId,

        webhookId: z
          .string()
          .describe(
            'Webhook UUID',
          ),
      }),

      handler: input =>
        webhook
          .findOne(
            input.sessionId,
            input.webhookId,
          )
          .then(webhookEntity =>
            WebhookResponseDto.fromEntity(
              webhookEntity,
            ),
          ),
    }),
  ];
}


