import { ApiCapability } from '../auth/capabilities/api-capability';
import { SUBSCRIBABLE_EVENTS } from './dto/ws-messages.dto';

/** A new event MUST declare a REST-equivalent read/manage capability. No implicit public events. */
export const WS_EVENT_CAPABILITIES: Readonly<Record<(typeof SUBSCRIBABLE_EVENTS)[number], ApiCapability>> = {
  'message.received': ApiCapability.CHAT_READ,
  'message.sent': ApiCapability.CHAT_READ,
  'message.ack': ApiCapability.CHAT_READ,
  'message.revoked': ApiCapability.CHAT_READ,
  'message.reaction': ApiCapability.CHAT_READ,
  'message.edited': ApiCapability.CHAT_READ,
  'session.status': ApiCapability.SESSION_READ,
  'session.qr': ApiCapability.SESSION_MANAGE,
  'session.connection_stage': ApiCapability.SESSION_READ,
  'session.authenticated': ApiCapability.SESSION_READ,
  'session.disconnected': ApiCapability.SESSION_READ,
  'session.restriction': ApiCapability.SESSION_READ,
  'group.join': ApiCapability.CHAT_READ,
  'group.leave': ApiCapability.CHAT_READ,
  'group.update': ApiCapability.CHAT_READ,
  'group.join_request': ApiCapability.CHAT_READ,
  'call.received': ApiCapability.CHAT_READ,
  'status.received': ApiCapability.CHAT_READ,
  'presence.update': ApiCapability.CHAT_READ,
  'call.accepted': ApiCapability.CHAT_READ,
  'call.rejected': ApiCapability.CHAT_READ,
  'call.missed': ApiCapability.CHAT_READ,
};
