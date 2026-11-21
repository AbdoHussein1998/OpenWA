import { ConflictException } from '@nestjs/common';

/**
 * A browser/page send call started, but its result cannot be proved. Never automatically retry
 * this operation: a timeout, disconnect, LID remap or missing result can happen after delivery.
 * The optional local message row id helps the caller inspect history, not prove delivery.
 */
export class SendOutcomeUncertainError extends ConflictException {
  constructor(localMessageId?: string) {
    super({
      statusCode: 409,
      code: 'SEND_OUTCOME_UNCERTAIN',
      message: 'WhatsApp send outcome is unknown. Do not resend automatically; reconcile with chat history first.',
      ...(localMessageId ? { localMessageId } : {}),
    });
  }
}
