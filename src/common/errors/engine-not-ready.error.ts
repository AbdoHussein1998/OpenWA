import { ConflictException } from '@nestjs/common';

export type EngineNotReadyCode =
  | 'ENGINE_NOT_READY'
  | 'ENGINE_REINJECTING';

/**
 * Thrown by the engine layer when an operation requires a connected, READY
 * WhatsApp client but the session cannot currently serve the operation.
 *
 * `ENGINE_NOT_READY` is the general disconnected/initializing/reconnecting
 * state. `ENGINE_REINJECTING` is narrower: the Session is still logically
 * READY, but WhatsApp Web has navigated and whatsapp-web.js is rebuilding its
 * page bridge. Both remain HTTP 409 so existing callers keep the same retryable
 * conflict semantics, while newer dashboard code can distinguish the expected
 * reinjection window without parsing human-readable text.
 */
export class EngineNotReadyError extends ConflictException {
  constructor(
    message = 'Session is not connected. The WhatsApp client is not ready.',
    code: EngineNotReadyCode = 'ENGINE_NOT_READY',
  ) {
    super({
      statusCode: 409,
      error: 'Conflict',
      code,
      message,
    });
  }
}
