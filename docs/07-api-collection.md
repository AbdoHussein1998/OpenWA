# 07 - API Collection

> **Branch scope:** `SunProject`. These cURL examples retain the existing REST and Socket.IO
> collection while documenting the branch's Team Leader/Agent access model, historical
> messaging, phone-attribution fields, and session-ownership constraints. The **generated
> `openapi.json` for the checked-out commit and the actual controller decorators** are the
> authority for exact routes and request/response DTOs. This collection is not a promise
> that every route below is available to every authenticated role.

## 07.1 Overview

This collection gives a runnable cURL for the primary OpenWA REST endpoints; the complete route list lives in `openapi.json` at the repository root. The Swagger UI at `/api/docs` serves the same schema, but it defaults off under `NODE_ENV=production` — set `ENABLE_SWAGGER=true` to serve it there. The examples assume two environment variables — set them once and reuse them:

```bash
export BASE=http://localhost:2785
export API_KEY=owa_k1_your-api-key-here
```

(For the metrics endpoint also `export METRICS_TOKEN=...`.)

### Authentication

REST API-key authentication uses the `X-API-Key` header; `?apiKey=` is **not** a supported
REST credential. `SunProject` defines `ADMIN`, `OPERATOR`, `VIEWER`, `TEAM_LEADER`, and
`AGENT` roles. The legacy OPERATOR/ADMIN annotations beside many examples describe the
operation's conventional minimum for the original three-role API; **do not interpret them
as a single five-role rank hierarchy**. Team Leader and Agent requests are checked against
the route's declared capability *and* the specific session's tenant ownership/assignment.
Admin-level settings, API-key lifecycle and cross-session operations require their explicit
administrative capability; a Team Leader/Agent is not made an administrator by owning or
being assigned a session. A nonempty `allowedSessions` restriction further **intersects**
the caller's effective scope; it never grants access outside that scope.

For a missing or invalid key expect `401`; for an authenticated key lacking the operation's
capability expect `403`; for a nonexistent **or inaccessible** session expect a tenant-aware
`404` (do not use response differences to enumerate another tenant's sessions). Some
session-history endpoints explicitly support deleted-session history through separate
historical authorization; normal start/send/configuration routes do not gain access through
that historical path. Consult the actual controller guards for route-specific requirements. The metrics endpoint uses `Authorization: Bearer $METRICS_TOKEN` instead.

```bash
# the auth header that prefixes nearly every call below
-H "X-API-Key: $API_KEY"
```

### Quick role/scope diagnostic

```bash
# First check whether the credential itself is valid; this does not authorize every route.
curl -X POST "$BASE/api/auth/validate" -H "X-API-Key: $API_KEY"

# Then test visibility of the actual session UUID (404 may mean absent OR out of scope).
curl "$BASE/api/sessions/$SESSION_ID" -H "X-API-Key: $API_KEY"
```

The branch's Team Leader and Agent administration surfaces live in
`src/modules/teamleader/`; their exact paths and DTOs should be read from the generated
`openapi.json` for the selected commit. To list candidate paths without guessing a route:

```bash
jq -r '.paths | keys[] | select(test("team|agent"; "i"))' openapi.json
```

Do **not** treat the presence of a path in OpenAPI as evidence your key has permission to
invoke it. Verify the controller capability and ownership/assignment policy as well.

### Responses

Responses are the **raw handler payloads** — there is no global `{ success, data }`
envelope. Many resource routes return an object and many list routes return bare JSON
arrays; **endpoint-specific shapes still apply** (for example, audit pagination returns
`{ data, total }`). Ordinary errors use NestJS's HTTP-exception fields, often
`{ "statusCode", "message", "error" }`; specific endpoints may provide additional
error details/codes. Add `Content-Type: application/json` when sending JSON.

### Sections

Sessions · Messages · Webhooks · Groups · Contacts · Chats · Labels · Channels · Catalog · Templates · Plugins · Settings · Auth (API Keys) · Health · Infrastructure · Stats · Audit · Metrics · Profile · Search · Media conversion · Events (WebSocket) · Team Leader/Agent role and tenant policy (see Authentication above and §07.18 below).

## 07.2 Endpoints

All examples assume `BASE` and `API_KEY` are exported (see 07.1). Paths are prefixed with `/api`.

The `:sessionId` path segment is always the session **UUID** returned by `POST /api/sessions` — never the session name. A session UUID is not a permission token: a scoped caller also needs the required route capability and effective session access. Session routes (07.3) use `:id` for that same UUID; everywhere else `:id` is a different resource's id — a template, webhook, API key or plugin — and never a session. Export the session UUID once alongside the other variables:

```bash
export SESSION_ID=8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a
```

### 07.3 Sessions

All routes are under `$BASE/api/sessions` and require `X-API-Key: $API_KEY` (except explicitly public routes). Reads come first, then writes. The actual route capability and the caller’s session scope both determine access; the legacy `OPERATOR` annotations below are not a universal five-role hierarchy.

#### GET /api/sessions

List all sessions visible to the key. Add `limit`/`offset` to page large installations.

```bash
curl -X GET "$BASE/api/sessions?limit=100&offset=0" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId

`sessionId` is the session UUID. A Team Leader must own the session; an Agent must be
assigned to that session through the expected Team Leader relationship. A foreign or
inaccessible UUID is not exposed merely because the caller knows its value.

Get a single session by ID.

```bash
curl -X GET "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/qr

Get the QR code (PNG data URL) for authentication (OPERATOR).

```bash
curl -X GET "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/qr" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/groups

List groups the session belongs to (paginated).

```bash
curl -X GET "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/groups?limit=100&offset=0" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/chats

List active chats, most-recent first (paginated).

```bash
curl -X GET "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/chats?limit=100&offset=0" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/stats/overview

Aggregate session statistics for monitoring.

```bash
curl -X GET "$BASE/api/sessions/stats/overview" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions

Create a new session (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "my-bot" }'
```

With an optional per-session egress proxy — only if your network can't reach WhatsApp directly. The
proxy **must be a real, reachable host**; an unreachable value silently blocks the WhatsApp WebSocket
(no QR is ever delivered) and `POST /api/sessions/:sessionId/start` returns `504` after ~30s:

```bash
curl -X POST "$BASE/api/sessions" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "my-bot", "proxyUrl": "http://user:pass@your-real-proxy.host:8080", "proxyType": "http" }'
```

#### POST /api/sessions/:sessionId/start

Start a session and initialize the connection (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/start" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/stop

Stop a session and disconnect (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/stop" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/logout

Attempt an engine-native unlink of this device, then stop the session (OPERATOR). Requires a running
session. A `200` means the unlink operation AND the required local cleanup completed — it is not an
independent observation that the handset UI no longer shows the linked device, and a later start
needs a fresh QR scan or pairing code. A `502` carries `code: 'SESSION_LOGOUT_INCOMPLETE'`: the
session was stopped locally but the logout operation did not complete (no send / no acknowledgement
/ timeout or transport error / local-cleanup failure); `phone` is cleared and no success audit is
written, so start the session again and retry.

```bash
curl -X POST "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/logout" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/force-kill

Force-kill a stuck session (OPERATOR). Returns `400` when the session is not started (there is no live engine to kill).

```bash
curl -X POST "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/force-kill" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/pairing-code

Request an 8-char pairing code via phone number (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/pairing-code" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "phoneNumber": "628123456789" }'
```

#### POST /api/sessions/:sessionId/presence/subscribe

Subscribe to presence updates (online/typing) for a chat (OPERATOR). Baileys only — whatsapp-web.js
answers `501`. The subscription belongs to the connection: re-issue it after a restart or reconnect.
Updates arrive as the `presence.update` webhook/socket event.

```bash
curl -X POST "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/presence/subscribe" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "1234567890@c.us" }'
```

#### GET /api/sessions/:sessionId/presence/:chatId

Read the last presence report received for a chat (any role). Returns `200` with a `null` body when
nothing has been reported yet — presence is held in memory, never persisted.

```bash
curl "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/presence/1234567890@c.us" \
  -H "X-API-Key: $API_KEY"
```

#### PUT /api/sessions/:sessionId/presence

Set the account's OWN global presence — appear online or offline (OPERATOR, both engines). The
setting does not survive a restart or reconnect; re-issue it after `session.status` reports one.

```bash
curl -X PUT "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/presence" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "available": false }'
```

#### POST /api/sessions/:sessionId/chats/read

Mark a chat as read/seen (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/chats/read" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "1234567890@c.us", "messageIds": ["3EB0C767D26B8A3F1A2B"] }'
```

`messageIds` is optional and holds up to 100 ids. Omit it and only the newest message the engine still
holds in memory is acknowledged, which on Baileys leaves the earlier messages of a burst unread.

#### POST /api/sessions/:sessionId/chats/unread

Mark a chat as unread (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/chats/unread" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "1234567890@c.us" }'
```

#### DELETE /api/sessions/:sessionId/chats/:chatId/messages

Delete every message in a chat, keeping the chat.

```bash
curl -X DELETE "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/chats/1234567890-123@g.us/messages" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/chats/archive

Archive or unarchive a chat.

```bash
curl -X POST "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/chats/archive" \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"chatId":"1234567890-123@g.us","archive":true}'
```

#### POST /api/sessions/:sessionId/chats/mute

Mute a chat until an epoch-**milliseconds** timestamp, or send `"muteUntil":null` to unmute (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/chats/mute" \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"chatId":"1234567890-123@g.us","muteUntil":1800000000000}'
```

#### POST /api/sessions/:sessionId/chats/pin

Pin a chat to the top of the list, or unpin it (OPERATOR). WhatsApp allows at most three pinned chats.

```bash
curl -X POST "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/chats/pin" \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"chatId":"1234567890-123@g.us","pin":true}'
```

#### POST /api/sessions/:sessionId/chats/delete

Delete a chat from the chat list (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/chats/delete" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "1234567890-123@g.us" }'
```

#### POST /api/sessions/:sessionId/chats/typing

Send a typing/recording presence indicator (or clear it with `paused`) (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/chats/typing" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "1234567890@c.us", "state": "typing" }'
```

#### DELETE /api/sessions/:sessionId

Delete a session (OPERATOR). Returns `204` with no body.

```bash
curl -X DELETE "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a" \
  -H "X-API-Key: $API_KEY"
```

### 07.4 Messages

All routes are under `/api/sessions/:sessionId/messages`. A read requires a valid key **and access to the requested session**; sends and other writes also require the route-specific capability. For legacy keys this often corresponds to `OPERATOR` or `ADMIN`, but `TEAM_LEADER` and `AGENT` have separate capability and tenant rules.

#### GET /api/sessions/:sessionId/messages

Get persisted message history from the `data` database (paginated, filterable).
It is a distinct data source from the engine's live chat history and the dashboard's
React Query cache. The message's `sessionId` is intentionally scalar rather than a
foreign key to the live `Session` row so stored history may outlive session deletion;
access after deletion requires an endpoint's **explicit historical-access authorization**.
Messages may include `author`, `sentByPhone`, and `sentToPhone`; phone-attribution fields
are nullable, and an unresolved WhatsApp `@lid` is **not** a phone number.

```bash
curl "$BASE/api/sessions/$SESSION_ID/messages?chatId=628123456789@c.us&limit=20&offset=0" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/messages/:chatId/history

Fetch history from the live WhatsApp engine, rather than treating the persisted database
as its source of truth. The available engine history can be bounded or absent after
restart; opening a chat or changing the dashboard's cache is not a guarantee of a
complete historical backfill. This route requires a reachable live session as well as
session access; an old persisted row is not sufficient to initialize a deleted engine.

```bash
curl "$BASE/api/sessions/$SESSION_ID/messages/628123456789@c.us/history?limit=100&deep=true" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/messages/:chatId/:messageId/reactions

Get reactions for a message, grouped by emoji.

```bash
curl "$BASE/api/sessions/$SESSION_ID/messages/628123456789@c.us/true_628123456789@c.us_3EB0ABCD/reactions" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/messages/vote-poll

Vote on a poll (whatsapp-web.js only).

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/vote-poll" \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"chatId":"628123456789@c.us","pollMessageId":"true_628123456789@c.us_3EB0ABCD","options":["Pizza"]}'
```

#### POST /api/sessions/:sessionId/messages/pin

Pin a message for 24h (default), 7d or 30d.

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/pin" \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"chatId":"628123456789@c.us","messageId":"true_628123456789@c.us_3EB0ABCD","durationSeconds":604800}'
```

#### POST /api/sessions/:sessionId/messages/star

Star or unstar a message.

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/star" \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"chatId":"628123456789@c.us","messageId":"true_628123456789@c.us_3EB0ABCD","star":true}'
```

#### POST /api/sessions/:sessionId/messages/unpin

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/unpin" \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"chatId":"628123456789@c.us","messageId":"true_628123456789@c.us_3EB0ABCD"}'
```

#### GET /api/sessions/:sessionId/messages/:chatId/:messageId/media

Download a message's stored media: the archived file when one exists (`CHAT_MEDIA_ARCHIVE_ENABLED`,
plus `CHAT_MEDIA_ARCHIVE_OUTBOUND` for media this account sent), else the inline copy on the message
row — which covers media sent by this account either way; `404` when neither holds bytes.

```bash
curl "$BASE/api/sessions/$SESSION_ID/messages/628123456789@c.us/true_628123456789@c.us_3EB0ABCD/media" \
  -H "X-API-Key: $API_KEY" -o media.bin
```

#### GET /api/sessions/:sessionId/messages/batch/:batchId

Get the status and progress of a bulk batch.

```bash
curl "$BASE/api/sessions/$SESSION_ID/messages/batch/batch_a1b2c3d4" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/messages/send-text

Send a plain text message.

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/send-text" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "text": "Hello from OpenWA!" }'
```

#### POST /api/sessions/:sessionId/messages/send-template

Render a stored template (`{{vars}}` substituted) and send it as text. A valid API key
must have both the template-send capability and access to this session. For an `AGENT`,
`AgentTemplateQuotaService` applies a rolling **24-hour stored-template quota**;
exhaustion can return `429`. That quota is not a generic limit on ordinary text/media
send endpoints and should not be bypassed by retrying the same template immediately.

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/send-template" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "templateName": "order-confirmation", "vars": { "customer": "Alice", "orderId": "1234" } }'
```

#### POST /api/sessions/:sessionId/messages/send-image

Send an image by URL or base64 with an optional caption.

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/send-image" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "url": "https://example.com/image.jpg", "caption": "Check out this image!" }'
```

#### POST /api/sessions/:sessionId/messages/send-video

Send a video by URL or base64 with an optional caption.

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/send-video" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "url": "https://example.com/clip.mp4", "caption": "video" }'
```

#### POST /api/sessions/:sessionId/messages/send-audio

Send an audio message by URL or base64. Add `"ptt": true` to send a real WhatsApp voice note (mic bubble + waveform); the server defaults the mimetype to `audio/ogg; codecs=opus` when `ptt` is set without one.

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/send-audio" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "url": "https://example.com/voice.ogg", "mimetype": "audio/ogg", "ptt": true }'
```

#### POST /api/sessions/:sessionId/messages/send-document

Send a document/file by URL or base64.

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/send-document" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "url": "https://example.com/report.pdf", "filename": "report.pdf", "mimetype": "application/pdf" }'
```

#### POST /api/sessions/:sessionId/messages/send-location

Send a location pin.

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/send-location" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "latitude": -6.2088, "longitude": 106.8456, "description": "Jakarta", "address": "Central Jakarta" }'
```

#### POST /api/sessions/:sessionId/messages/send-contact

Send a contact card (vCard).

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/send-contact" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "contactName": "John Doe", "contactNumber": "628987654321" }'
```

#### POST /api/sessions/:sessionId/messages/send-sticker

Send a sticker by URL or base64 (typically webp).

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/send-sticker" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "url": "https://example.com/sticker.webp", "mimetype": "image/webp" }'
```

#### POST /api/sessions/:sessionId/messages/send-poll

Send a native WhatsApp poll (2–12 options; single choice unless `allowMultipleAnswers` is true).

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/send-poll" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "1203630000@g.us", "name": "Where should we meet?", "options": ["Park", "Beach", "Downtown"] }'
```

#### POST /api/sessions/:sessionId/messages/reply

Reply to a message, quoting a prior one.

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/reply" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "quotedMessageId": "true_628123456789@c.us_3EB0ABCD", "text": "Replying to you" }'
```

#### POST /api/sessions/:sessionId/messages/forward

Forward a message from one chat to another.

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/forward" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "fromChatId": "628111111111@c.us", "toChatId": "628222222222@c.us", "messageId": "true_628111111111@c.us_3EB0XYZ" }'
```

#### POST /api/sessions/:sessionId/messages/react

Add a reaction (send an empty `emoji` to remove it).

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/react" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "messageId": "true_628123456789@c.us_3EB0ABCD", "emoji": "👍" }'
```

#### POST /api/sessions/:sessionId/messages/delete

Delete a message (for everyone by default).

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/delete" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "messageId": "true_628123456789@c.us_3EB0ABCD", "forEveryone": true }'
```

#### POST /api/sessions/:sessionId/messages/edit

Edit the text of a message sent by this account (OPERATOR); the edited message keeps its original id.

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/edit" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "messageId": "true_628123456789@c.us_3EB0ABCD", "body": "Corrected text" }'
```

#### POST /api/sessions/:sessionId/messages/send-bulk

Send to multiple recipients as an asynchronous batch (max 100 messages; exact
duplicate entries — same `chatId`, `type`, `content` and `variables` — are collapsed,
first occurrence wins). The running batch state and send outcomes are not made
distributed-safe merely by the existence of session-owner leases. If a node loses
ownership partway through a batch, do **not** automatically replay its ambiguous sends;
inspect batch status and reconcile with recipients before manual recovery.

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/send-bulk" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      { "chatId": "628111111111@c.us", "type": "text", "content": { "text": "Hi {{name}}" }, "variables": { "name": "Alice" } },
      { "chatId": "628222222222@c.us", "type": "image", "content": { "image": { "url": "https://example.com/promo.jpg" }, "caption": "Promo" } }
    ],
    "options": { "delayBetweenMessages": 3000, "randomizeDelay": true, "stopOnError": false }
  }'
```

#### POST /api/sessions/:sessionId/messages/batch/:batchId/cancel

Cancel a running bulk batch (no body).

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/batch/batch_a1b2c3d4/cancel" \
  -H "X-API-Key: $API_KEY"
```

### 07.5 Contacts

#### GET /api/sessions/:sessionId/contacts

List contacts for a session (paginated window).

```bash
curl -X GET "$BASE/api/sessions/$SESSION_ID/contacts?limit=100&offset=0" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/contacts/check/:number

Check whether a phone number is on WhatsApp.

```bash
curl -X GET "$BASE/api/sessions/$SESSION_ID/contacts/check/628123456789" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/contacts/:contactId

Get a single contact by its WhatsApp id.

```bash
curl -X GET "$BASE/api/sessions/$SESSION_ID/contacts/6281234567890@c.us" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/contacts/:contactId/profile-picture

Get a contact's profile picture URL.

```bash
curl -X GET "$BASE/api/sessions/$SESSION_ID/contacts/6281234567890@c.us/profile-picture" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/contacts/:contactId/phone

This is a resolution request, not a guarantee that every WhatsApp privacy ID can be
mapped to a public phone number. When a mapping is not known, preserve the `@lid`
identity; never infer a phone number by removing its suffix.

Resolve a contact id (e.g. an @lid) to a phone number.

```bash
curl -X GET "$BASE/api/sessions/$SESSION_ID/contacts/12345678901234@lid/phone" \
  -H "X-API-Key: $API_KEY"
```

#### PUT /api/sessions/:sessionId/contacts/:contactId

Save or edit an addressbook contact.

```bash
curl -X PUT "$BASE/api/sessions/$SESSION_ID/contacts/628123456789@c.us" \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"firstName":"Ada","lastName":"Lovelace"}'
```

#### DELETE /api/sessions/:sessionId/contacts/:contactId

Remove an addressbook contact.

```bash
curl -X DELETE "$BASE/api/sessions/$SESSION_ID/contacts/628123456789@c.us" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/contacts/:contactId/block

Block a contact (requires an OPERATOR key). Send an empty body.

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/contacts/6281234567890@c.us/block" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

#### DELETE /api/sessions/:sessionId/contacts/:contactId/block

Unblock a contact (requires an OPERATOR key).

```bash
curl -X DELETE "$BASE/api/sessions/$SESSION_ID/contacts/6281234567890@c.us/block" \
  -H "X-API-Key: $API_KEY"
```

### 07.6 Groups

#### GET /api/sessions/:sessionId/groups

List all groups for a session (paginated).

```bash
curl -X GET "$BASE/api/sessions/$SESSION_ID/groups?limit=1000&offset=0" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/groups/:groupId

Get detailed group info including participants.

```bash
curl -X GET "$BASE/api/sessions/$SESSION_ID/groups/120363021234567890@g.us" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/groups/:groupId/invite-code

Get the group invite code and full invite link.

```bash
curl -X GET "$BASE/api/sessions/$SESSION_ID/groups/120363021234567890@g.us/invite-code" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/groups

Create a new group with an initial set of participants (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/groups" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Project Team", "participants": ["628123456789@c.us", "628987654321@c.us"] }'
```

#### POST /api/sessions/:sessionId/groups/:groupId/participants

Add participants to a group (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/groups/120363021234567890@g.us/participants" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "participants": ["628123456789@c.us"] }'
```

#### DELETE /api/sessions/:sessionId/groups/:groupId/participants

Remove participants from a group (OPERATOR). This DELETE takes a JSON body.

```bash
curl -X DELETE "$BASE/api/sessions/$SESSION_ID/groups/120363021234567890@g.us/participants" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "participants": ["628123456789@c.us"] }'
```

#### POST /api/sessions/:sessionId/groups/:groupId/participants/promote

Promote participants to group admin (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/groups/120363021234567890@g.us/participants/promote" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "participants": ["628123456789@c.us"] }'
```

#### POST /api/sessions/:sessionId/groups/:groupId/participants/demote

Demote participants from group admin (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/groups/120363021234567890@g.us/participants/demote" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "participants": ["628123456789@c.us"] }'
```

#### PUT /api/sessions/:sessionId/groups/:groupId/subject

Change the group name/subject (OPERATOR).

```bash
curl -X PUT "$BASE/api/sessions/$SESSION_ID/groups/120363021234567890@g.us/subject" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "subject": "New Team Name" }'
```

#### PUT /api/sessions/:sessionId/groups/:groupId/description

Change the group description; an empty string clears it (OPERATOR).

```bash
curl -X PUT "$BASE/api/sessions/$SESSION_ID/groups/120363021234567890@g.us/description" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "description": "Internal coordination group." }'
```

#### POST /api/sessions/:sessionId/groups/:groupId/leave

Leave a group (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/groups/120363021234567890@g.us/leave" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/groups/:groupId/invite-code/revoke

Revoke the current invite code and generate a new one (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/groups/120363021234567890@g.us/invite-code/revoke" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/groups/join-info

Preview a group from its invite code WITHOUT joining (both engines). Read-only, so it is safe to
call on a code from an untrusted source. There is no participant list — only `participantCount`,
and only when WhatsApp discloses one.

```bash
curl "$BASE/api/sessions/$SESSION_ID/groups/join-info?code=XyZ987654321" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/groups/join

Join a group via an invite code — the part after `https://chat.whatsapp.com/` (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/groups/join" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "inviteCode": "XyZ987654321" }'
```

#### GET /api/sessions/:sessionId/groups/:groupId/membership-requests

List a group's pending join requests (the queue the `group.join_request` event announces). The
account must be a group admin — WhatsApp refuses the read otherwise (`403`).

```bash
curl "$BASE/api/sessions/$SESSION_ID/groups/120363021234567890@g.us/membership-requests" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/groups/:groupId/membership-requests/approve

Approve pending join requests (OPERATOR) — the named requesters, or EVERY pending request when the
body names none. The response carries a per-requester `results` list; a partial refusal does not
fail the batch.

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/groups/120363021234567890@g.us/membership-requests/approve" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "participants": ["628123456789@c.us"] }'
```

#### POST /api/sessions/:sessionId/groups/:groupId/membership-requests/reject

Reject pending join requests (OPERATOR). Same body, response shape and batch contract as `approve`.

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/groups/120363021234567890@g.us/membership-requests/reject" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "participants": ["628123456789@c.us"] }'
```

### 07.7 Message Templates

All template routes are nested under a session and require the declared template-management capability **and** access to that session. Historical OPERATOR-level wording applies to the legacy roles; a `TEAM_LEADER` or `AGENT` follows its own capability and tenant policy.

#### GET /api/sessions/:sessionId/templates

List all templates for a session, newest first.

```bash
curl "$BASE/api/sessions/$SESSION_ID/templates" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/templates/:id

Get a single template by ID.

```bash
curl "$BASE/api/sessions/$SESSION_ID/templates/$TEMPLATE_ID" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/templates

Create a message template with `{{variable}}` placeholders.

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/templates" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "order-confirmation",
    "body": "Hi {{customer}}, your order {{orderId}} has shipped.",
    "header": "OpenWA Store",
    "footer": "Reply STOP to unsubscribe."
  }'
```

#### PUT /api/sessions/:sessionId/templates/:id

Update a template (partial; only provided fields change).

```bash
curl -X PUT "$BASE/api/sessions/$SESSION_ID/templates/$TEMPLATE_ID" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "body": "Hi {{customer}}, your order {{orderId}} is out for delivery.",
    "footer": "Thanks for shopping with us."
  }'
```

#### DELETE /api/sessions/:sessionId/templates/:id

Delete a template by ID (returns `204` empty body).

```bash
curl -X DELETE "$BASE/api/sessions/$SESSION_ID/templates/$TEMPLATE_ID" \
  -H "X-API-Key: $API_KEY"
```

### 07.8 Catalog & Channels

The catalog routes work on the **Baileys** engine (WhatsApp Business accounts) — `getCatalog`/`getProducts`/`getProduct` read the session's own catalog and `sendProduct` sends a native product card. On **whatsapp-web.js** they raise `EngineNotSupportedError` (`501 Not Implemented`) — the library has no catalog API at all; on that engine the readiness check runs first, so a session that exists but is not yet READY returns `409` instead. The per-engine gaps are listed in `docs/29-engine-capability-matrix.md`. The channel routes that follow are a separate group with real engine support.

#### GET /api/sessions/:sessionId/catalog

Get business catalog info for the session. On Baileys returns the first catalog collection's metadata (`200`, or `null` when the business has no collections); on whatsapp-web.js returns `501`.

```bash
curl -X GET "$BASE/api/sessions/$SESSION_ID/catalog" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/catalog/products

List catalog products with pagination. Works on Baileys (page/limit over the full catalog walk); returns `501` on whatsapp-web.js.

```bash
curl -X GET "$BASE/api/sessions/$SESSION_ID/catalog/products?page=1&limit=20" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/catalog/products/:productId

Get a specific catalog product by id. On Baileys returns the product (`200`) or `null` for an unknown id; on whatsapp-web.js returns `501`.

```bash
curl -X GET "$BASE/api/sessions/$SESSION_ID/catalog/products/PROD_12345" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/messages/send-product

Send a product card to a chat (OPERATOR key required). On Baileys returns `404` for an unknown product id and `400` when the product has no image; on whatsapp-web.js returns `501`.

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/messages/send-product" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "6281234567890@c.us", "productId": "PROD_12345", "body": "Check out this item!" }'
```

#### GET /api/sessions/:sessionId/channels

List subscribed channels/newsletters.

```bash
curl -X GET "$BASE/api/sessions/$SESSION_ID/channels" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/channels/:channelId

Get a single channel by id.

```bash
curl -X GET "$BASE/api/sessions/$SESSION_ID/channels/120363000000000000@newsletter" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/channels/:channelId/messages

Get recent messages from a channel.

```bash
curl -X GET "$BASE/api/sessions/$SESSION_ID/channels/120363000000000000@newsletter/messages?limit=50" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/channels/subscribe

Subscribe to a channel by invite code (OPERATOR key required).

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/channels/subscribe" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "inviteCode": "ABC123xyz" }'
```

#### DELETE /api/sessions/:sessionId/channels/:channelId

Unsubscribe from a channel (OPERATOR key required).

```bash
curl -X DELETE "$BASE/api/sessions/$SESSION_ID/channels/120363000000000000@newsletter" \
  -H "X-API-Key: $API_KEY"
```

### 07.9 Labels & Status

```bash
# List all labels for a session (WhatsApp Business only)
curl -X GET "$BASE/api/sessions/$SESSION_ID/labels" \
  -H "X-API-Key: $API_KEY"
```

```bash
# Get a single label by ID
curl -X GET "$BASE/api/sessions/$SESSION_ID/labels/5" \
  -H "X-API-Key: $API_KEY"
```

```bash
# List labels assigned to a chat
curl -X GET "$BASE/api/sessions/$SESSION_ID/labels/chat/6281234567890@c.us" \
  -H "X-API-Key: $API_KEY"
```

```bash
# Add a label to a chat (OPERATOR)
curl -X POST "$BASE/api/sessions/$SESSION_ID/labels/chat/6281234567890@c.us" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "labelId": "5" }'
```

```bash
# Remove a label from a chat (OPERATOR)
curl -X DELETE "$BASE/api/sessions/$SESSION_ID/labels/chat/6281234567890@c.us/5" \
  -H "X-API-Key: $API_KEY"
```

```bash
# Get all status updates (stories) visible to the session
curl -X GET "$BASE/api/sessions/$SESSION_ID/status" \
  -H "X-API-Key: $API_KEY"
```

```bash
# Get status updates posted by a specific contact
curl -X GET "$BASE/api/sessions/$SESSION_ID/status/6281234567890@c.us" \
  -H "X-API-Key: $API_KEY"
```

```bash
# Post a text status (OPERATOR)
curl -X POST "$BASE/api/sessions/$SESSION_ID/status/send-text" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "text": "Hello from OpenWA!", "backgroundColor": "#25D366", "font": 2 }'
```

```bash
# Post an image status from a URL (OPERATOR)
curl -X POST "$BASE/api/sessions/$SESSION_ID/status/send-image" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "image": { "url": "https://example.com/photo.jpg" }, "caption": "My status" }'
```

```bash
# Post a video status from a URL (OPERATOR)
curl -X POST "$BASE/api/sessions/$SESSION_ID/status/send-video" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "video": { "url": "https://example.com/clip.mp4" }, "caption": "Watch this" }'
```

```bash
# Post a voice-note status (OPERATOR). WhatsApp only plays Ogg/Opus — neither engine
# transcodes, so convert first via media/convert/voice and post the base64 it returns.
# `recipients` (the viewer allow-list) is honored on Baileys only. There is no `caption`.
curl -X POST "$BASE/api/sessions/$SESSION_ID/status/send-voice" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "audio": { "base64": "T2dnUwACAAAA..." }, "recipients": ["6281234567890@c.us"] }'
```

```bash
# Delete one of the session's own posted statuses (OPERATOR)
curl -X DELETE "$BASE/api/sessions/$SESSION_ID/status/false_status@broadcast_3A1F" \
  -H "X-API-Key: $API_KEY"
```

### 07.10 Webhooks (management)

All routes require the relevant webhook-management capability and access to the session; for legacy roles this commonly means OPERATOR/ADMIN. `secret` and `headers` are write-only (never returned by these routes; `GET /api/infra/export-data` omits them from webhook rows too). The per-session routes live under `/api/sessions/:sessionId/webhooks`; the cross-session list is `/api/webhooks`.

#### GET /api/sessions/:sessionId/webhooks

List all webhooks for a session (newest first).

```bash
curl -X GET "$BASE/api/sessions/$SESSION_ID/webhooks" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/webhooks/:id

Get a single webhook by ID, scoped to the session.

```bash
curl -X GET "$BASE/api/sessions/$SESSION_ID/webhooks/f1e2d3c4-b5a6-7890-1234-567890abcdef" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/webhooks

List webhooks visible to the calling key (scoped to its allowed sessions). Add `limit`/`offset` to page large lists.

```bash
curl -X GET "$BASE/api/webhooks?limit=100&offset=0" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/webhooks/delivery-failures

List webhook deliveries that exhausted every retry, most recent first (ADMIN; results stay confined
to the key's allowed sessions). `lastStatusCode` is `null` when the failure was a
network/timeout/SSRF error rather than a non-2xx response.

```bash
curl -X GET "$BASE/api/webhooks/delivery-failures?limit=100&offset=0" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/webhooks

Create a webhook for the session.

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/webhooks" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-server.com/webhook",
    "events": ["message.received", "session.status"],
    "secret": "your-secret-key",
    "headers": { "X-Custom-Header": "value" },
    "filters": {
      "conditions": [
        { "field": "sender", "operator": "is", "value": ["1234567890@c.us"] },
        { "field": "body", "operator": "contains", "value": "invoice" }
      ]
    },
    "retryCount": 3
  }'
```

#### PUT /api/sessions/:sessionId/webhooks/:id

Update a webhook (partial; only provided fields change).

```bash
curl -X PUT "$BASE/api/sessions/$SESSION_ID/webhooks/f1e2d3c4-b5a6-7890-1234-567890abcdef" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": ["*"],
    "active": false,
    "retryCount": 5,
    "filters": null
  }'
```

#### POST /api/sessions/:sessionId/webhooks/:id/test

Send a synthetic test payload to the webhook URL and report the result (no request body).

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/webhooks/f1e2d3c4-b5a6-7890-1234-567890abcdef/test" \
  -H "X-API-Key: $API_KEY"
```

#### DELETE /api/sessions/:sessionId/webhooks/:id

Delete a webhook (returns `204` no content).

```bash
curl -X DELETE "$BASE/api/sessions/$SESSION_ID/webhooks/f1e2d3c4-b5a6-7890-1234-567890abcdef" \
  -H "X-API-Key: $API_KEY"
```

### 07.11 API Keys

All `/api/auth/api-keys` routes require an **ADMIN** key. `POST /api/auth/validate` accepts any valid key. The plaintext key is returned only by the create call.

#### GET /api/auth/api-keys

List all API keys (newest first).

```bash
curl -X GET "$BASE/api/auth/api-keys" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/auth/api-keys/:id

Get one API key by id.

```bash
curl -X GET "$BASE/api/auth/api-keys/3f2a1c9e-1b2d-4a5f-9c8e-aa11bb22cc33" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/auth/api-keys

Only an appropriately authorized Admin can mint keys. `SunProject` also supports
Team Leader and Agent identities/bindings; do not create a purported Team Leader or
Agent by changing only the `role` field of a generic API key. Use the actual branch
management flow and DTOs to establish the principal and its authorized session
ownership/assignment. The example below creates a legacy Operator key.

Create a key; the response includes the full plaintext key once.

```bash
curl -X POST "$BASE/api/auth/api-keys" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production Bot",
    "role": "operator",
    "allowedIps": ["192.168.1.1", "10.0.0.0/8"],
    "allowedSessions": ["session-uuid-1"],
    "expiresAt": "2027-12-31T23:59:59Z"
  }'
```

#### PUT /api/auth/api-keys/:id

Update name/role/allowedIps/allowedSessions/expiresAt.

```bash
curl -X PUT "$BASE/api/auth/api-keys/3f2a1c9e-1b2d-4a5f-9c8e-aa11bb22cc33" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Renamed Bot",
    "role": "viewer",
    "allowedIps": ["203.0.113.5"],
    "expiresAt": "2028-01-01T00:00:00Z"
  }'
```

#### POST /api/auth/api-keys/:id/revoke

Deactivate a key without deleting it (no body).

```bash
curl -X POST "$BASE/api/auth/api-keys/3f2a1c9e-1b2d-4a5f-9c8e-aa11bb22cc33/revoke" \
  -H "X-API-Key: $API_KEY"
```

#### DELETE /api/auth/api-keys/:id

Permanently delete a key (returns `204`, no body).

```bash
curl -X DELETE "$BASE/api/auth/api-keys/3f2a1c9e-1b2d-4a5f-9c8e-aa11bb22cc33" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/auth/validate

Validate the supplied key and report its role (empty body; key read from the header).

```bash
curl -X POST "$BASE/api/auth/validate" \
  -H "X-API-Key: $API_KEY"
```

### 07.12 System (Health, Metrics, Stats, Settings, Audit)

#### GET /api/health

Basic health check (status, timestamp). Public. The running `version` is added only when the request carries a valid API key, so an unauthenticated probe gets `status` and `timestamp` alone.

```bash
curl "$BASE/api/health"

# With the version field:
curl -H "X-API-Key: $API_KEY" "$BASE/api/health"
```

#### GET /api/health/live

Liveness probe — always `{ "status": "ok" }`. Public.

```bash
curl "$BASE/api/health/live"
```

#### GET /api/health/ready

Readiness probe — checks both datasources; `503` while draining or on DB failure. Public.

```bash
curl "$BASE/api/health/ready"
```

#### GET /api/metrics

Prometheus scrape. Gated by the metrics bearer token (not the API key); `404` when `METRICS_TOKEN` is unset.

```bash
curl "$BASE/api/metrics" \
  -H "Authorization: Bearer $METRICS_TOKEN"
```

#### GET /api/stats/overview

Cross-session aggregate stats. ADMIN key required.

```bash
curl "$BASE/api/stats/overview" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/stats/messages

Message stats over a period (`24h` | `7d` | `30d`, default `24h`). ADMIN key required.

```bash
curl "$BASE/api/stats/messages?period=7d" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/stats/sessions/:sessionId

A `TEAM_LEADER` or `AGENT` key must pass the same session-ownership or assignment
policy that protects other session-scoped reads; a broadly worded `any role` annotation
should not be read as `any session`.

Per-session stats. Any role; a session-restricted key can only read stats for its allowed sessions.

```bash
curl "$BASE/api/stats/sessions/9f1c2d3e-…" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/settings

Read runtime settings (env-derived). ADMIN key required (`403` otherwise).

```bash
curl "$BASE/api/settings" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/audit

List audit-log entries, newest first (ADMIN; rows stay confined to the key's allowed sessions).
Unlike the other list routes the body is `{ "data", "total" }` — the page plus the unpaginated
match count. Filters: `action`, `severity` (`info` | `warn` | `error`), `sessionId`, `apiKeyId`,
plus `limit` (default 50, max 200) and `offset`.

```bash
curl -X GET "$BASE/api/audit?action=session_started&limit=50" \
  -H "X-API-Key: $API_KEY"
```

### 07.13 Administration (Infrastructure, Plugins, MCP)

ADMIN-only operations (except the public health check and the MCP transport). Assumes `BASE`, `API_KEY`, and — for MCP — that `MCP_ENABLED=true`.

#### GET /api/infra/health

Public liveness probe.

```bash
curl "$BASE/api/infra/health"
```

#### GET /api/infra/status

Aggregate infra status (DB, Redis, queue, storage, engine).

```bash
curl "$BASE/api/infra/status" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/infra/engines

List available WhatsApp engine plugins.

```bash
curl "$BASE/api/infra/engines" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/infra/engines/current

Get the currently active engine type.

```bash
curl "$BASE/api/infra/engines/current" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/infra/config

Read effective infrastructure config (secrets omitted) — each field resolves with the boot precedence (environment / `.env` over `data/.env.generated`).

```bash
curl "$BASE/api/infra/config" \
  -H "X-API-Key: $API_KEY"
```

#### PUT /api/infra/config

Merge-save infrastructure config to `data/.env.generated`.

```bash
curl -X PUT "$BASE/api/infra/config" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "database": { "type": "postgres", "host": "db.example.com", "port": "5432", "username": "openwa", "password": "s3cret", "database": "openwa", "poolSize": 10, "sslEnabled": true, "sslRejectUnauthorized": false },
    "redis": { "enabled": true, "builtIn": true },
    "queue": { "enabled": true },
    "storage": { "type": "s3", "s3Bucket": "my-bucket", "s3Region": "ap-southeast-1", "s3AccessKey": "AKIA...", "s3SecretKey": "...", "s3Endpoint": "https://s3.example.com" },
    "engine": { "type": "whatsapp-web.js", "headless": true }
  }'
```

#### POST /api/infra/restart

Request a graceful restart, optionally orchestrating Docker profiles.

```bash
curl -X POST "$BASE/api/infra/restart" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "profiles": ["postgres", "redis"], "profilesToRemove": ["minio"] }'
```

#### GET /api/infra/export-data

Export all Data DB rows as JSON for migration.

```bash
curl "$BASE/api/infra/export-data" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/infra/import-data

Replace all Data DB rows with a prior export (destructive, all-or-nothing). Every one of the 14 migration tables is emptied first, so a key you omit restores **empty** rather than untouched — send a body produced by `GET /api/infra/export-data`, not a hand-built subset. All 14 keys are shown below for that reason.

```bash
curl -X POST "$BASE/api/infra/import-data" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "tables": {
      "sessions": [ { "id": "s1", "name": "main", "status": "ready", "phone": "15551234567", "pushName": "Me", "config": {}, "proxyUrl": null, "proxyType": null, "connectedAt": "2026-06-25T00:00:00.000Z", "lastActiveAt": "2026-06-25T00:00:00.000Z", "createdAt": "2026-06-25T00:00:00.000Z", "updatedAt": "2026-06-25T00:00:00.000Z" } ],
      "webhooks": [], "messages": [], "messageBatches": [], "templates": [], "baileysStoredMessages": [],
      "lidMappings": [], "pluginInstances": [], "conversationMappings": [], "ingressEvents": [],
      "webhookDeliveryFailures": [], "integrationDeliveryFailures": [], "statusUpdates": [], "automationRules": []
    }
  }'
```

#### GET /api/infra/storage/files/count

File count and total size in the active storage backend.

```bash
curl "$BASE/api/infra/storage/files/count" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/infra/storage/export

Export all storage files to a tar.gz; returns its server-side path.

```bash
curl "$BASE/api/infra/storage/export" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/infra/storage/import

Import storage files from a tar.gz located inside `data/`.

```bash
curl -X POST "$BASE/api/infra/storage/import" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "filePath": "./data/exports/storage-export-1750000000000-abc.tar.gz" }'
```

#### GET /api/plugins

List all loaded plugins (secrets redacted).

```bash
curl "$BASE/api/plugins" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/plugins/catalog

List the remote plugin catalog with install state.

```bash
curl "$BASE/api/plugins/catalog" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/plugins/:id

Get a single plugin by id.

```bash
curl "$BASE/api/plugins/chat-flow" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/plugins/:id/config-ui

Fetch a plugin's sandboxed config-UI HTML. The dashboard renders it in an opaque-origin iframe,
uses a `postMessage` bridge for config, and retains any schema form as a fallback.

```bash
curl "$BASE/api/plugins/chat-flow/config-ui" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/plugins/:id/health

Check a plugin's health.

```bash
curl "$BASE/api/plugins/chat-flow/health" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/plugins/install

Install a plugin from an uploaded .zip (multipart, field `file`, max 5 MB).

```bash
curl -X POST "$BASE/api/plugins/install" \
  -H "X-API-Key: $API_KEY" \
  -F "file=@my-plugin.zip"
```

#### POST /api/plugins/install-url

Install a plugin by downloading its .zip from a URL (SSRF-guarded).

```bash
curl -X POST "$BASE/api/plugins/install-url" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://github.com/openwa-plugins/chat-flow/releases/download/v1.0.0/chat-flow.zip" }'
```

#### POST /api/plugins/:id/enable

Enable a plugin.

```bash
curl -X POST "$BASE/api/plugins/chat-flow/enable" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/plugins/:id/disable

Disable a plugin.

```bash
curl -X POST "$BASE/api/plugins/chat-flow/disable" \
  -H "X-API-Key: $API_KEY"
```

#### PUT /api/plugins/:id/config

Update a plugin's base configuration.

```bash
curl -X PUT "$BASE/api/plugins/chat-flow/config" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "config": { "apiKey": "sk-...", "replyDelayMs": 1500 } }'
```

#### PUT /api/plugins/:id/config/:sessionId

Set (or clear with `{}`) a per-session plugin config override. The override is stored under the session UUID and resolved against the UUID carried by each event, so an id that is not a live session's UUID never takes effect.

```bash
curl -X PUT "$BASE/api/plugins/chat-flow/config/$SESSION_ID" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "config": { "replyDelayMs": 3000 } }'
```

#### PUT /api/plugins/:id/sessions

Set which sessions a session-scoped plugin is activated for (`["*"]` = all).

```bash
curl -X PUT "$BASE/api/plugins/chat-flow/sessions" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "sessions": ["*"] }'
```

#### POST /api/plugins/:id/update

Update an installed plugin in place from a URL.

```bash
curl -X POST "$BASE/api/plugins/chat-flow/update" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com/plugins/chat-flow-1.1.0.zip" }'
```

#### DELETE /api/plugins/:id

Uninstall a plugin (built-ins protected).

```bash
curl -X DELETE "$BASE/api/plugins/chat-flow" \
  -H "X-API-Key: $API_KEY"
```

#### POST /mcp

MCP JSON-RPC 2.0 transport (no `/api` prefix; gated by `MCP_ENABLED=true`). The API key goes via `X-Api-Key` or `Authorization: Bearer`; auth is enforced per tool call. The server is **read-only by default** — write tools such as `MessageSendText` are only mounted when `MCP_READONLY=false`. See doc 24 for the tool catalog.

```bash
# Initialize handshake
curl -X POST "$BASE/mcp" \
  -H "X-Api-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "openwa-collection", "version": "1.0.0" } } }'

# List available tools
curl -X POST "$BASE/mcp" \
  -H "X-Api-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }'

# Call a tool (arguments must match the tool's zod inputSchema; requires MCP_READONLY=false)
curl -X POST "$BASE/mcp" \
  -H "X-Api-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "MessageSendText", "arguments": { "sessionId": "'"$SESSION_ID"'", "chatId": "6281234567890@c.us", "text": "Hello from MCP" } } }'
```

### 07.14 Profile (own account)

Manage the linked account's own profile. All routes are nested under a session and require an
OPERATOR key.

#### PUT /api/sessions/:sessionId/profile/name

Set the account display name (max 25 chars).

```bash
curl -X PUT "$BASE/api/sessions/$SESSION_ID/profile/name" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "ACME Support" }'
```

#### PUT /api/sessions/:sessionId/profile/status

Set the account about/status text (max 139 chars; empty string clears it).

```bash
curl -X PUT "$BASE/api/sessions/$SESSION_ID/profile/status" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "status": "We reply within one business day" }'
```

#### PUT /api/sessions/:sessionId/profile/picture

Set the account profile picture from a URL or base64 image (same media DTO conventions as message
sends).

```bash
curl -X PUT "$BASE/api/sessions/$SESSION_ID/profile/picture" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com/avatar.png" }'
```

#### DELETE /api/sessions/:sessionId/profile/picture

Remove the account profile picture (WhatsApp's default avatar takes over). Removing a picture that
is already absent is a no-op and also answers `200`.

```bash
curl -X DELETE "$BASE/api/sessions/$SESSION_ID/profile/picture" \
  -H "X-API-Key: $API_KEY"
```

### 07.15 Search

Cross-session full-text message search (OPERATOR or higher). On by default; `SEARCH_ENABLED=false`
removes the route and module entirely. A scoped key's `allowedSessions` is applied server-side and
cannot be widened via the query. See doc 26 for the provider contract.

#### GET /api/search

Search messages across sessions. `q` is required (non-empty after trim); optional filters are
`sessionId`, `chatId`, `direction` (`incoming` | `outgoing`), `type`, `from`, `dateFrom`/`dateTo`
(epoch ms), plus `limit` (default 50, clamped to `SEARCH_LIMIT_MAX` = 100) and `offset`. Hit
`snippet` fields carry `<mark>` highlight markers — render them as text, never as HTML.

```bash
curl -X GET "$BASE/api/search?q=invoice&direction=incoming&limit=20" \
  -H "X-API-Key: $API_KEY"
```

### 07.16 Media conversion (opt-in)

Server-side transcoding into the shapes WhatsApp clients actually play. Disabled by default; set
`MEDIA_CONVERSION_ENABLED=true`, and `ffmpeg` must be runnable (the official Docker image ships it)
or the routes answer `503`. Nothing is converted implicitly — run media through here first, then
post the result.

#### GET /api/sessions/:sessionId/media/convert

Report whether conversion is switched on and runnable here (`{ "available": true }`). Any role.

```bash
curl "$BASE/api/sessions/$SESSION_ID/media/convert" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/media/convert/voice

Convert audio (or a video's audio track) into a WhatsApp voice note — Ogg/Opus, mono, 48 kHz
(OPERATOR). Exactly one of `url` / `base64`. Post the returned `base64` to `messages/send-audio`
with `ptt: true` (or to `status/send-voice`).

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/media/convert/voice" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com/voice-memo.mp3" }'
```

#### POST /api/sessions/:sessionId/media/convert/video

Convert video into a baseline H.264/AAC MP4 every WhatsApp client accepts (OPERATOR); same request
body and errors as the voice endpoint. Both responses are bounded by
`MEDIA_CONVERSION_MAX_OUTPUT_BYTES` (default 50 MiB).

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/media/convert/video" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com/clip.mov" }'
```

### 07.17 Real-time (WebSocket)

Events are delivered over **Socket.IO** on the `/events` namespace (not a raw WebSocket).
Use the `socket.io-client` package. Set `BASE_WS` (e.g. `ws://localhost:2785`) and
`API_KEY`. Authentication occurs on connection, and session subscriptions require
server-side authorization: a Team Leader/Agent must not gain another tenant's events by
requesting an arbitrary UUID or a wildcard room. Use a concrete session UUID for
restricted keys. A `message.received` socket event, persisted history row, and dashboard
message-cache update are different stages; verify each when investigating chat-sync
issues. Redis broadcast fan-out, when configured, does not imply globally synchronized
WebSocket credential-revocation or rate-limit state.

```bash
npm install socket.io-client
```

```js
// realtime.mjs — run: BASE_WS=ws://localhost:2785 API_KEY=... SESSION_ID=<session-uuid> node realtime.mjs
import { io } from 'socket.io-client';

const BASE_WS = process.env.BASE_WS || 'ws://localhost:2785';
const API_KEY = process.env.API_KEY;
const SESSION_ID = process.env.SESSION_ID; // concrete session UUID for restricted/tenant keys; '*' only if authorized

const socket = io(`${BASE_WS}/events`, {
  auth: { apiKey: API_KEY }, // or the x-api-key header
});

socket.on('connect', () => {
  console.log('connected:', socket.id);
  socket.emit('message', {
    type: 'subscribe',
    sessionId: SESSION_ID,
    events: ['*'], // or e.g. ['message.received', 'session.status']
    requestId: 'sub-1',
  });
});

socket.on('message', msg => {
  if (msg.type === 'event') {
    console.log(`[${msg.payload.event}] ${msg.payload.sessionId}`, msg.payload.data);
  } else {
    console.log(`[${msg.type}]`, msg); // subscribed | unsubscribed | pong | error
  }
});

socket.on('connect_error', err => console.error('connect_error:', err.message));
socket.on('disconnect', reason => console.log('disconnected:', reason));
```

### 07.18 SunProject session ownership, tenant access, and response verification

**Current deployment requirement:** use one API replica per session-data volume.
`SessionOwnershipService` maintains renewable ownership leases for process-local
WhatsApp engines, and the takeover module can adopt eligible expired leases through
the normal lifecycle. Optional `NODE_URL` forwarding and Redis Socket.IO fan-out exist,
but they do **not** make all lifecycle, live bulk-send, MCP/agent-tool and WebSocket
security paths uniformly distributed-safe. Do not use these features as a rationale for
an undocumented multi-replica deployment.

**Role-aware endpoints:** the Admin/Team Leader/Agent feature implementation is in
`src/modules/teamleader/`. Obtain exact paths, parameters and DTOs from the
`SunProject` commit's `openapi.json` and `src/modules/teamleader/*.controller.ts`.
These newer endpoints are deliberately **not** assigned hypothetical cURL commands
here: incorrect example routes can appear valid while targeting the wrong API.
For any such route, validate the credential's capability, Team Leader ownership,
Agent assignment, and `allowedSessions` intersection independently.

**Deleted-session history:** the `data` connection stores messages with a scalar
session identifier; deletion of a live session does not automatically erase all
message provenance. Only explicitly history-aware API routes may authorize a read
against a historical session/tombstone. A successful historical read does not allow
a caller to send a message through a deleted engine.

**Message identity and sender/recipient:** compare `(sessionId, WhatsApp message ID)`
when correlating stored rows and incoming socket events. The `author` may identify a
group participant distinct from the group `from`/`chatId`. `sentByPhone` and
`sentToPhone` can be `null` when the phone is unknown, including unresolved `@lid`
identities; clients must never fabricate a phone number from the privacy-ID digits.

**Cross-connection references:** principals and API keys are in the `main` SQLite
connection; sessions and messages are in the `data` connection (SQLite or PostgreSQL).
Owner/assignment identifiers that cross these connections are enforced by the
application's access-control services, not by a cross-database SQL foreign key.

**Troubleshooting path:** identify whether a failure is authentication (`401`),
capability (`403`), tenant scope / missing session (`404`), stored-template quota
(`429`), engine readiness, owner routing, database projection, or Socket.IO
subscription/cache. The chat-list preview changing does not demonstrate that the
open thread's persisted-history query or live-event cache update succeeded.
