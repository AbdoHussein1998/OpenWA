# 22 - n8n Integration

> **Branch scope:** OpenWA `SunProject`. This document describes the OpenWA REST/webhook
contract and the separately maintained community n8n package. The package's published
resource list and version may differ from the `SunProject` API; verify an operation in the
installed node before relying on branch-only role, Team Leader, or Agent features.

## Overview

OpenWA can be integrated with n8n through its community nodes or directly through n8n HTTP Request and Webhook nodes. The community package is maintained separately from the `SunProject` branch; the HTTP/webhook approach is useful for an API operation that the installed node version has not exposed.

**Repository:** https://github.com/rmyndharis/OpenWA-n8n
**npm Package:** `@rmyndharis/n8n-nodes-openwa`

### SunProject authentication and session access

OpenWA accepts an API key in the `X-API-Key` HTTP header. The branch defines `ADMIN`,
`OPERATOR`, `VIEWER`, `TEAM_LEADER`, and `AGENT` roles; route capabilities and access to a
particular session are **independent** checks. Team Leaders can access their own sessions;
Agents can access only an appropriately assigned session; a nonempty `allowedSessions`
list additionally narrows access. A valid key may therefore receive `403` on an operation
it cannot perform or `404` for a session it cannot access. The ordinary legacy
`OPERATOR` role is not interchangeable with Team Leader/Agent permissions.

Create a dedicated credential with only the required operation and session scope. An
Agent's stored-template sends are subject to a rolling 24-hour template quota; this is
**not** a universal rate limit for every WhatsApp send. Do not use an Admin key solely to
work around a missing node operation or a tenant-scope error.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   n8n Workflow  │────▶│  OpenWA Node    │────▶│  OpenWA API     │
│                 │     │  (credentials)  │     │  (your server)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   n8n Workflow  │◀────│ OpenWA Trigger  │◀────│  Webhook POST   │
│   (triggered)   │     │  (listens)      │     │  from OpenWA    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

## Installation

### Via n8n Community Nodes (Recommended)

1. Go to **Settings > Community Nodes**
2. Select **Install**
3. Enter `@rmyndharis/n8n-nodes-openwa`
4. Agree to the risks and install
5. Restart n8n

### Manual Installation

```bash
cd ~/.n8n/nodes
npm install @rmyndharis/n8n-nodes-openwa
```

## Nodes

### OpenWA Node

Execute operations on your OpenWA server.

#### Credentials Setup

| Field      | Description                      | Example                  |
| ---------- | -------------------------------- | ------------------------ |
| Server URL | OpenWA server URL (without /api) | `https://wa.example.com` |
| API Key    | OpenWA API key whose capability **and session scope** authorize this workflow | `owa_k1_...` |

#### Resources & Operations

The table below lists operations documented for the **community node**. It is not a
complete inventory of `SunProject` REST routes. To use an unlisted operation, check the
branch's `openapi.json` and invoke the exact documented endpoint with an n8n HTTP Request
node and `X-API-Key` header; do not assume that a community-node release automatically
implements Team Leader/Agent provisioning or all role-specific operations.

| Resource | Operation     | Description                 | Endpoint                                        |
| -------- | ------------- | --------------------------- | ----------------------------------------------- |
| Session  | Get Status    | Get session status          | `GET /api/sessions/:id`                         |
| Session  | List All      | List all sessions           | `GET /api/sessions`                             |
| Message  | Send Text     | Send text message           | `POST /api/sessions/:id/messages/send-text`     |
| Message  | Send Image    | Send image (URL/Base64)     | `POST /api/sessions/:id/messages/send-image`    |
| Message  | Send Document | Send file/document          | `POST /api/sessions/:id/messages/send-document` |
| Message  | Send Location | Send location pin           | `POST /api/sessions/:id/messages/send-location` |
| Contact  | Check Exists  | Check if number on WhatsApp | `GET /api/sessions/:id/contacts/check/:number`  |
| Contact  | Get Info      | Get contact information     | `GET /api/sessions/:id/contacts/:contactId`     |
| Webhook  | Create        | Create a webhook            | `POST /api/sessions/:id/webhooks`               |
| Webhook  | Delete        | Delete a webhook            | `DELETE /api/sessions/:id/webhooks/:webhookId`  |

### OpenWA Trigger Node

Start workflows when WhatsApp events occur.

#### Supported Events

| Event                                             | Description                                   | Use Case                                     |
| ------------------------------------------------- | --------------------------------------------- | -------------------------------------------- |
| `message.received`                                | New incoming message                          | Auto-reply, lead capture                     |
| `message.sent`                                    | OpenWA emitted an outbound-send event         | Sent-message tracking; **not** recipient delivery proof |
| `message.ack`                                     | Delivery/read status advanced                 | Read receipts                                |
| `message.failed`                                  | Outgoing message failed                       | Failure alerting                             |
| `message.revoked`                                 | Message deleted for everyone                  | Deletion tracking                            |
| `message.reaction`                                | Reaction added / changed / removed            | Reaction tracking                            |
| `message.edited`                                  | Message body or caption edited                | Content synchronization                      |
| `status.received`                                 | Contact posted a Status update                | Status archiving                             |
| `session.status`                                  | Session status changed                        | Lifecycle tracking                           |
| `session.qr`                                      | QR code generated                             | Reconnection alerts                          |
| `session.authenticated`                           | Session logged in (phone available)           | Startup notifications                        |
| `session.disconnected`                            | Session lost connection                       | Alert monitoring                             |
| `session.reconnect_loop`                          | Every 5th consecutive reconnect attempt       | Stuck-session alerting                       |
| `session.restriction`                             | WhatsApp restricted the account, or lifted it | Pausing outreach while an account is limited |
| `presence.update`                                 | A watched chat's online/typing state changed  | Live agent hand-off, presence-aware routing  |
| `call.accepted` / `call.rejected` / `call.missed` | A ringing call ended — **Baileys only**       | Missed-call follow-up, call logging          |
| `group.join`                                      | Participant(s) joined a group                 | Welcome messages                             |
| `group.leave`                                     | Participant(s) left a group                   | Churn tracking                               |
| `group.update`                                    | Group subject/description/settings changed    | Group administration                         |
| `group.join_request`                              | Someone asked to join an administered group   | Auto-approve/vet join requests               |
| `call.received`                                   | Incoming call started ringing                 | Auto-reject + auto-reply bots                |

> [!NOTE]
> The three call-outcome events fire on Baileys only. whatsapp-web.js hooks the call collection's
> insert and sees no status at all, so it can report the ring but never how the call ended — a
> workflow triggered on `call.missed` will simply never run on a whatsapp-web.js session.
> `call.received` fires on both engines.

#### How It Works

The trigger node creates a webhook for the session used in its configuration. That
registration also needs webhook-management capability and access to the target session;
using a key that can send messages does not automatically mean it can create webhooks.
A general `message.received` event is distinct from the dashboard's live thread cache;
workflows receive webhook deliveries, not React state updates.

1. When workflow is activated, the trigger creates a webhook in OpenWA
2. OpenWA sends events to n8n's webhook URL
3. When workflow is deactivated, the webhook is automatically deleted

#### Output Data Format

```json
{
  "event": "message.received",
  "timestamp": "2024-01-15T10:30:00Z",
  "sessionId": "default",
  "idempotencyKey": "a1b2c3d4e5f6...",
  "deliveryId": "9f8e7d6c5b4a...",
  "data": {
    "id": "3EB0F5A2B4C...",
    "chatId": "628123456789@c.us",
    "from": "628123456789@c.us",
    "body": "Hello!",
    "type": "text",
    "timestamp": 1705312200
  }
}
```

> **Identity and phone fields.** `sessionId` is the OpenWA session UUID, not its display name.
> In the message payload, `from`/`chatId` are WhatsApp identifiers, not guaranteed phone
> numbers. An unresolved privacy identifier (`@lid`) is not a phone number. Where message
> attribution fields such as `author`, `sentByPhone`, and `sentToPhone` are included,
> phone fields may legitimately be `null`; do not derive a number by stripping a suffix
> from an LID or a group ID.
>
> **Deduplication.** Every delivery includes `idempotencyKey` and `deliveryId` in the body **and** as the
> `X-OpenWA-Idempotency-Key` / `X-OpenWA-Delivery-Id` headers. `idempotencyKey` is **stable across retries**
> of the same event; `deliveryId` identifies one delivery to one webhook and is stable across that
> delivery's retry attempts too — read the `X-OpenWA-Retry-Count` header for the attempt number. Because a
> webhook can be retried, add a dedup step keyed on `idempotencyKey` (e.g. an n8n IF or "Remove Duplicates"
> node) so a retried delivery isn't processed twice.

## Example Workflows

### 1. Auto-Reply Bot

Automatically reply to incoming messages with a welcome message.

```
[OpenWA Trigger] → [IF: Check keyword] → [OpenWA: Send Text]
     │
     └── Events: message.received
```

**Configuration:**

- Trigger: `message.received`
- IF Node: Check if `{{$json.data.body}}` contains "hello"
- OpenWA: Send Text with welcome message

### 2. Lead Collection to Google Sheets

Capture incoming messages and save to Google Sheets.

```
[OpenWA Trigger] → [Google Sheets: Append] → [OpenWA: Send Text]
     │                    │
     │                    └── Save: name, phone, message
     └── Events: message.received
```

### 3. Session Monitoring

Get notified on Slack when WhatsApp session disconnects.

```
[OpenWA Trigger] → [Slack: Send Message]
     │
     └── Events: session.disconnected
```

**Slack Message:**

```
⚠️ WhatsApp session "{{$json.sessionId}}" disconnected!
Time: {{$json.timestamp}}
Please check and reconnect.
```

### 4. Order Notification

Send WhatsApp notification when new order is received.

```
[Webhook: New Order] → [OpenWA: Send Text]
                            │
                            └── "Thank you for your order #{{$json.orderId}}"
```

### 5. Scheduled Reminders

Send daily reminders to a list of contacts.

```
[Schedule Trigger] → [Google Sheets: Get Rows] → [Loop] → [OpenWA: Send Text]
     │                      │                                    │
     └── Daily 9AM          └── Get contacts                     └── Send reminder
```

### 6. Appointment Booking

Collect appointment requests over WhatsApp, check availability in an external scheduling source, and send a confirmation or alternative time slots.

See [n8n Appointment Booking Workflow](./examples/n8n-appointment-booking.md) for a complete example.

```
[OpenWA Trigger] → [IF: Booking intent?] → [Set: Normalize request]
                                               │
                                               ▼
                                      [Availability Source]
                                               │
                         ┌─────────────────────┴─────────────────────┐
                         ▼                                           ▼
              [Create Booking] → [OpenWA: Send Text]      [OpenWA: Send Text]
                  confirmed confirmation                  alternative slots
```

## Best Practices

### 1. Error Handling

Always add error handling in your workflows:

```
[OpenWA Node] → [IF: Check success] → [Continue...]
                      │
                      └── [Error Handler]
```

### 2. Rate Limiting

Use backoff after `429` and inspect which limit applied: an Agent's rolling stored-template
quota, an API request limit, and WhatsApp send pacing are different mechanisms. A generic
retry loop should not immediately resend a quota-rejected template or an outbound send whose
result is ambiguous after a network timeout.

WhatsApp has rate limits. Add delays between messages:

```
[Loop Over Items] → [Wait: 2 seconds] → [OpenWA: Send Text]
```

### 3. Message Formatting

Use WhatsApp formatting in your messages:

- Bold: `*text*`
- Italic: `_text_`
- Strikethrough: `~text~`
- Monospace: `` `text` ``

### 4. Phone Number Format

Use the engine-neutral chat identifier returned by OpenWA. The normal personal-chat form
contains a phone number, but an unresolved `@lid` remains a privacy ID. Resolve it through
the contact/identity API when possible; never present the LID digits as a phone number.

Always use the correct format for chat IDs:

- Personal: `628123456789@c.us`
- Group: `123456789-123456789@g.us`

## Troubleshooting

### Credential Test Failed

1. Verify OpenWA server is running
2. Check API key is correct
3. Ensure server URL doesn't have trailing slash
4. Verify network connectivity between n8n and OpenWA

### Trigger Not Receiving Events

1. **Confirm you registered the production webhook URL, not the test one.** n8n gives every Webhook
   node two URLs: a test URL (`https://your-n8n/webhook-test/…`) and a production URL
   (`https://your-n8n/webhook/…`). The test URL is registered only while the editor is listening and
   stops after a single request, so a workflow wired to it receives one event and then goes silent.
   Activate the workflow and point OpenWA at the production URL.
2. Check webhook was created in OpenWA dashboard
3. Verify n8n webhook URL is accessible from OpenWA server
4. Check firewall/proxy settings
5. Ensure session is connected and active
6. For a call-outcome trigger, confirm the session runs Baileys — see the note under the trigger
   event table above
7. Inspect `GET /api/webhooks/delivery-failures?sessionId={sessionId}` with an appropriately
   authorized Admin key. A failure row indicates **exhausted delivery retries**; it may be
   caused by n8n returning a non-2xx status **or** a network, timeout, or SSRF failure.
   An empty list does **not** prove the event reached n8n: also inspect webhook registration,
   event filters, event projection, dispatch, and job processing.

### Message Not Sending

First distinguish a missing/invalid key (`401`), an operation disallowed for the role
(`403`), an inaccessible or missing target session (`404`), and an Agent stored-template
quota rejection (`429`) from a WhatsApp send failure. A session shown as `ready` by a
chat preview does not by itself establish that its engine is available on the node
handling the API request.

1. Verify session status is `ready` (the API returns lowercase status values)
2. Check chat ID format is correct
3. Ensure recipient number exists on WhatsApp
4. Check message content isn't empty

## SunProject workflow examples beyond the packaged node

**Send a stored template through an HTTP Request node:** use the documented
`POST /api/sessions/:sessionId/messages/send-template` route with JSON fields
`chatId`, `templateName`, and `vars`. Bind `sessionId` to the **session UUID** and use a
credential authorized for both that session and the template-send capability. For an
Agent credential, treat a `429` template-quota response as a terminal outcome for that
attempt rather than converting it to an immediate retry.

**Read persisted history:** use `GET /api/sessions/:sessionId/messages?chatId=...&limit=...`.
Persisted messages and a live WhatsApp history request are different reads; webhook
retries do not make an n8n workflow a complete message archive. Use the `idempotencyKey`
to deduplicate event processing, and use the session UUID plus WhatsApp message ID as a
separate business-level identity when reconciling history.

**Call role-specific management APIs:** locate their current routes in the branch's
`openapi.json` or Swagger schema. This guide intentionally does not invent new
Team Leader/Agent paths or assert that the upstream community node provides them.

## Development

### Building from Source

```bash
git clone https://github.com/rmyndharis/OpenWA-n8n.git
cd OpenWA-n8n
npm install
npm run build
```

### Local Development

```bash
# Watch mode
npm run dev

# Link to local n8n
cd ~/.n8n/nodes
npm link /path/to/OpenWA-n8n
```

### Testing

Test your changes with a local n8n instance:

```bash
# Start n8n
n8n start

# Or with Docker
docker run -it --rm \
  -p 5678:5678 \
  -v ~/.n8n:/home/node/.n8n \
  n8nio/n8n
```

## Related Documentation

- [OpenWA API Specification](./06-api-specification.md)
- [Webhook System](./03-system-architecture.md#353-webhook-system)
- [n8n Appointment Booking Workflow](./examples/n8n-appointment-booking.md)
- [n8n Documentation](https://docs.n8n.io/)

---

<div align="center">

[← 21 - Glossary](./21-glossary.md) · [Documentation Index](./README.md)

</div>