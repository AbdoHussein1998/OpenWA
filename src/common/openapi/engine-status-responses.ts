/**
 * Response descriptions shared by every route that reaches a WhatsApp engine.
 *
 * Kept in one place rather than repeated per controller: the text describes the engine's own
 * behaviour, not any one route's, so eleven copies would drift apart the moment one of them was
 * reworded — which is how the contract fell behind the code in the first place.
 */

/**
 * `EngineNotReadyError` (409) — thrown by every adapter's `ensureReady()` guard, which each engine
 * method calls before touching the socket or the page. Distinct from the 409 the session, auth and
 * plugin routes already declare: those report a semantic conflict (a name already taken, a plugin
 * already installed, a session already running), whereas this one says the session exists but has
 * no live engine behind it yet.
 */
export const ENGINE_NOT_READY_409 =
  'The session is not connected — it exists, but no engine is running for it, so the request never ' +
  'reached WhatsApp. Start the session and retry. Distinct from the `409` the session lifecycle ' +
  'routes answer, which reports a conflicting state rather than a missing engine.';

/**
 * `RecipientUnreachableError` (400) — whatsapp-web.js could not resolve the recipient to an
 * addressable id, so the send never left the gateway.
 */
export const RECIPIENT_UNREACHABLE_400 =
  'The recipient could not be addressed — WhatsApp reports no deliverable id for that `chatId`, ' +
  'which is how it says the number is not reachable on WhatsApp. `400` rather than `404`, because a ' +
  '`404` on these routes already means the session was not found.';

/** `EngineRefusedError` (403) — the request was well formed; WhatsApp itself refused it. */
export const ENGINE_REFUSED_403 =
  'WhatsApp refused the operation. The request was well formed — the refusal happened WhatsApp-side, ' +
  'most often because the account lacks the admin rights the operation requires.';

/** `MessageNotFoundError` (404) — outside the adapter's lookup window, or revoked. */
export const MESSAGE_NOT_FOUND_404 =
  "No such message — the id is outside the engine's lookup window (roughly the last hundred messages " +
  'of the chat, or absent from the Baileys store) or the message was revoked.';

/** `ChannelNotFoundError` (404). */
export const CHANNEL_NOT_FOUND_404 =
  "No such channel — the id is not among the session's subscribed channels, either because it is " +
  'wrong or because the channel has not synced into the local collection yet.';

/** `GroupNotFoundError` (404) — unknown id, or an id that addresses a 1:1 chat. */
export const GROUP_NOT_FOUND_404 = 'No such group — the id is unknown, or it addresses a 1:1 chat rather than a group.';

/** `LabelNotFoundError` (404) — never created, or the account is not a Business one. */
export const LABEL_NOT_FOUND_404 =
  'No such label — it was never created, or the account is not a WhatsApp Business one and holds no ' +
  'labels at all. Both are the same answer to the caller.';

/** `EngineNotSupportedError` (501) — in the engine contract, but not implementable on this engine. */
export const ENGINE_NOT_SUPPORTED_501 =
  'The active engine cannot serve this operation. It is part of the engine contract, but the engine ' +
  'currently running has no implementation for it.';

/** `ChannelMediaNotSupportedError` (501) — media to an `@newsletter` recipient on whatsapp-web.js. */
export const CHANNEL_MEDIA_501 =
  'Sending media to a channel (`<id>@newsletter`) is not supported by the whatsapp-web.js engine — ' +
  'the page method it needs was removed by a WhatsApp Web update. Text to a channel still works.';
