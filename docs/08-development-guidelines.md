# 08 - Development Guidelines

> **Scope:** OpenWA `SunProject` branch. Work from the existing code and interfaces, not from generic NestJS examples. Read [03 - System Architecture](./03-system-architecture.md) for responsibility boundaries and [13 - Horizontal Scaling](./13-horizontal-scaling.md) before changing ownership, failover, routing, or deployment. **Supported production topology is still one API replica per session-data volume.**

## 8.1 Project Structure

```text
openwa/
├── src/
│   ├── main.ts                       # NestJS bootstrap
│   ├── app.module.ts                 # Root module and named main/data databases
│   ├── common/                       # Cache, storage, security, errors, logger, helpers
│   ├── config/                       # App configuration, env validation, feature flags
│   ├── core/                         # Plugin loader, hooks, agent tools
│   ├── database/
│   │   ├── data-source.ts            # data: SQLite or PostgreSQL
│   │   ├── data-source-main.ts       # main: SQLite
│   │   ├── migrations/               # data migrations
│   │   └── migrations-main/          # main migrations
│   ├── engine/
│   │   ├── interfaces/               # IWhatsAppEngine and engine-neutral events
│   │   ├── adapters/                 # whatsapp-web.js and Baileys implementations
│   │   ├── identity/                 # WhatsApp/JID and LID normalization
│   │   ├── engine.factory.ts         # Configured engine/plugin creation
│   │   └── engine-registry.service.ts # Locally running engines
│   └── modules/
│       ├── auth/                     # API keys, five roles, guards, capabilities
│       ├── access-control/           # SessionTenantAccessService and scopes
│       ├── teamleader/               # Admin, Team Leader, Agent endpoints and quota
│       ├── session/                  # Session lifecycle, ownership, MessageProjector
│       ├── takeover/                 # Expired-lease recovery
│       ├── message/                  # MessageService, MessageSendService, message entity
│       ├── events/                   # Socket.IO gateway
│       └── ...                       # Webhooks, queues, integrations, contacts, media, etc.
├── dashboard/
│   └── src/
│       ├── App.tsx                   # Role-aware application routing
│       ├── services/api.ts          # API client; reads raw handler responses
│       ├── hooks/                   # React Query hooks and event/cache updates
│       └── i18n/                    # Locale setup and translation catalogs
├── test/                             # Backend E2E tests and shared setup
├── sdk/                              # Language SDKs
├── docs/                             # Architecture, deployment, and usage guidance
├── scripts/                          # Validation, versioning, patches, API contracts
├── .github/workflows/                # CI and release workflows
├── package.json
├── tsconfig.json
└── docker-compose.yml
```

**Before editing a feature:** identify its frontend route/component and data hook (if any), API controller, guard and tenant check, capability service, named TypeORM connection/repository, engine adapter callback or send method (if any), event/webhook publisher, and existing tests. Trace this actual path before introducing a new service or moving responsibilities.

## 8.2 Coding Standards

### TypeScript and imports

Use the root `tsconfig.json` for backend and colocated tests, and the dashboard's own TypeScript/Vite settings for frontend code. The backend is configured for NodeNext module resolution and TypeScript strict-null checks with specific documented opt-outs. Keep imports relative unless the target workspace already establishes an alias; do not introduce an unrelated alias while implementing a feature.

```bash
npx tsc --noEmit -p tsconfig.json
npm run lint
cd dashboard && npm run lint
```

Use the existing naming and formatting conventions: `kebab-case` filenames, `PascalCase` classes and DTOs, `camelCase` functions and local variables, and `UPPER_SNAKE_CASE` constants. **Do not assume one enum-member naming pattern applies to every entity**: inspect the actual enum. For example, `ApiKeyRole.TEAM_LEADER`, `MessageDirection.INCOMING`, and `EngineStatus.READY` use upper-case members.

Use `createLogger` from the shared logger service instead of adding `console.log` to production code. Include safe context such as session ID and request ID; do not leak API credentials, messages, phone numbers, or full SQL parameter values to production logs.

### Preserve established architecture

- Controllers validate HTTP input, declare authentication/capability requirements, and call services. They **must not** import `IWhatsAppEngine`, obtain an engine from `EngineRegistry`, or perform ad hoc database operations that belong to feature services.
- Capability services may inject `EngineRegistry` to access an engine running **on the current node**. `SessionService`/`SessionEngineLifecycle` own start/stop/delete/reconnect and should be used when a workflow truly changes session lifecycle.
- `MessageSendService` owns outgoing message sending, pacing, hooks, and persistence. `MessageProjector` in `src/modules/session/` owns inbound/echo/history/ack/mutation projection. Avoid duplicating these paths in controllers, the dashboard, or engine adapters.
- Extend the existing `IWhatsAppEngine` abstraction when a feature must work across `whatsapp-web.js` and Baileys. Normalize WhatsApp IDs at the engine/identity boundary; never infer that `@lid` is a phone number.
- Reuse established modules, services, DTOs, and tests; do not add a new global module or a broad refactor solely to implement a local change.

## 8.3 Module Structure and Feature Implementation

### 8.3.1 Standard NestJS feature structure

A typical HTTP feature has a `*.module.ts`, `*.controller.ts`, `*.service.ts`, DTOs, and (where necessary) entities and colocated `*.spec.ts` tests. Not every existing module has every file; for example, `events/` is gateway-oriented and `queue/` is processor/module wiring. Follow the **specific feature's established layout**, not a fixed boilerplate template.

```typescript
// Illustrative dependency-injection pattern for an existing repository-backed feature.
@Module({
  imports: [TypeOrmModule.forFeature([Session], 'data')],
  controllers: [ExampleController],
  providers: [ExampleService],
  exports: [ExampleService],
})
export class ExampleModule {}

@Injectable()
export class ExampleService {
  constructor(
    @InjectRepository(Session, 'data')
    private readonly sessions: Repository<Session>,
  ) {}
}
```

`@Module` registers providers and controllers in NestJS's dependency-injection container. The equivalent FastAPI organization would usually pass a database session/service through dependencies, but the NestJS module's `imports` and `exports` control provider visibility; a Python import alone is not the same as NestJS provider registration. The snippet is a **pattern**, not a file to add verbatim.

### 8.3.2 Choose the correct database before adding an entity

There are **two named TypeORM connections**:

| Connection | Backend | Existing responsibility | Migration directory |
| --- | --- | --- | --- |
| `main` | SQLite only | API keys, Team Leaders, Agents, Agent template-send usage, audit | `src/database/migrations-main/` |
| `data` | SQLite (`better-sqlite3`) or PostgreSQL | Sessions, messages, webhooks, templates, integration state, historical session data | `src/database/migrations/` |

The actual `TeamLeaderModule` imports `TeamLeader`, `Agent`, `ApiKey`, and `AgentTemplateSendUsage` through the `main` connection and `Session` through `data`. A service that uses both must inject each repository with its explicit connection name:

```typescript
// Pattern only: retain existing class/import conventions in the target module.
constructor(
  @InjectRepository(Agent, 'main')
  private readonly agents: Repository<Agent>,

  @InjectRepository(Session, 'data')
  private readonly sessions: Repository<Session>,
) {}
```

**Do not create a TypeORM relation or SQL foreign key between `main` and `data`.** For example, `Agent.assignedSessionId` and `Session.ownerTeamLeaderId` represent business relationships spanning the two databases; service-layer validation enforces their meaning. Within the `main` database, an API key can have actual TypeORM relations to its Team Leader or Agent.

Do not add a `Message.sessionId → Session.id` foreign key: `Message.sessionId` deliberately remains scalar so historical messages survive deletion of the live session. Deleted-session history uses the separate historical authorization flow and session tombstones. Decide whether another proposed FK has a similar retention or import/rebind requirement before introducing it.

### 8.3.3 Controller, capability, and session-access checks

The global API-key guard authenticates requests unless a route is explicitly public. Roles are `ADMIN`, `OPERATOR`, `VIEWER`, `TEAM_LEADER`, and `AGENT`. Authentication, capability authorization, and tenant-session access are **different checks**:

```text
API key authentication
  → endpoint capability / role requirement
  → effective session scope via SessionTenantAccessService
  → live-session or explicitly historical-session access
  → feature service and repository / engine
```

`SessionTenantAccessService.getEffectiveSessionScope` intersects role/tenant scope with a nonempty `allowedSessions` ceiling. A Team Leader can access owned sessions; an Agent can access only its assigned session within that leader's ownership. An Agent with no assignment has no session scope. On a foreign session, return the established `404` rather than disclosing that it exists. Apply the same central scope semantics to REST, authenticated Socket.IO subscriptions, and MCP/agent-tool entry points where session access is required; a React route guard is **not** an authorization check.

Use `assertSessionAccess` for a live session. Use `assertHistoricalSessionAccess` only on endpoints explicitly allowed to read persisted data after the live session has been deleted. Do not permit normal send/start/configuration endpoints to fall back to a historical tombstone.

### 8.3.4 Make session changes through the lifecycle

For start, stop, delete, logout, reconnect, or recovery changes, inspect `src/modules/session/session.service.ts`, the session engine-lifecycle service, `SessionOwnershipService`, and `src/modules/takeover/`. Do not manually delete a `Session` row to implement a user-facing deletion operation: that bypasses engine teardown, auth files, ownership release, and related cleanup.

An engine exists only in its owning process's `EngineRegistry`. Lease renewal and an expiring claim are implemented, but **multi-replica production remains unsupported**. Do not mark a feature as distributed-safe solely because it reads `nodeId` or because the HTTP forwarding path is available.

### 8.3.5 Message entity, WhatsApp IDs, and phone attribution

The message entity is `src/modules/message/entities/message.entity.ts`. Relevant fields include `sessionId`, `waMessageId`, `chatId`, `from`, `to`, optional `author`, `sentByPhone`, and `sentToPhone`, plus body, type, direction, timestamp, status, and metadata. The `(sessionId, waMessageId)` uniqueness constraint supports deduplication/ack lookup; an appropriate migration is required for every persisted field change.

| Case | Sender identity | Phone-column rule |
| --- | --- | --- |
| Incoming one-to-one | `from` | Resolve phone only from a real phone JID or an established mapping. |
| Incoming group | `author` (group `from` remains chat context) | Use the participant for `sentByPhone`, **not** the group JID. |
| Outgoing direct message | Current account → recipient | Resolve sender and recipient when available. |
| Group, status, unresolved LID, legacy record | Preserve actual WhatsApp IDs | Nullable phone fields may remain null; never copy LID digits into them. |

Check `src/modules/message/message-phone.util.ts`, `src/modules/session/message-projector.service.ts`, and existing message-row mapping/send code before changing attribution. Verify both initial send persistence and asynchronous own-send echo/history reconciliation. Storing a nullable phone column **does not guarantee** that every WhatsApp user or chat exposes a phone number.

### 8.3.6 Template sends and Agent quota

`AgentTemplateQuotaService` enforces a rolling 24-hour quota for authenticated **Agent stored-template sends**. This is separate from general message pacing and HTTP throttling. Reuse its reservation/accounting logic in a new stored-template send path rather than checking usage in the controller or applying this quota to unrelated plain text/media sends. Ensure an Agent's session assignment and tenant scope are still checked separately.

### 8.3.7 Dashboard routes, data access, and translation

Role-aware routes belong in `dashboard/src/App.tsx` and the project's existing role-access utilities. The dashboard API client in `dashboard/src/services/api.ts` consumes the backend's **raw** handler payload; do not unilaterally introduce `{success, data, meta}` wrapping in either layer.

The chat-message hook is `dashboard/src/hooks/useChatMessages.ts`. It organizes messages by `['messages', sessionId, chatId]`, reads persisted and available engine history, and applies live events to matching cached threads. When changing live message behavior, verify socket session subscription, message identity/normalization, React Query cache creation, cache updates, and reconnect/refetch behavior. Do not add a second independent chat array just to mask a missing cache update.

The dashboard uses `dashboard/src/i18n/` and locale catalogs. Add/update translation keys for **all supported locales** when changing visible text and validate right-to-left layout where applicable (including Arabic/Hebrew). A language selector does not demonstrate complete translation coverage; verify every edited page and error state. Check accessibility, loading states, route capabilities, and mobile layout with each relevant UI change.

## 8.4 Git Workflow

Work in a feature or bug-fix branch from the intended project base. Keep changes incremental and scoped. A backend/API change, frontend integration, migration, and regression test should be separable in review when feasible. Example commit messages:

```text
fix(message): reconcile inbound chat cache independently of chat page
feat(teamleader): validate session assignment before agent template send
docs(architecture): document session leases and deployment limits
```

A pull request should identify observable behavior, root cause for bug fixes, exact affected modules/files, schema and compatibility implications, tests run, documentation updates, and unresolved limitations. Do not claim a migration has been applied to production or a test has passed until it actually has.

### Pull request checklist

- [ ] Change is limited to the required scope and reuses existing services/DTOs.
- [ ] Authentication, role capability, tenant scope, and deleted-session history behavior are tested as applicable.
- [ ] Database connection and migration choice are explicit; backward-compatible schema evolution is considered.
- [ ] Both WhatsApp engines and ID/phone handling are considered where applicable.
- [ ] Dashboard cache, Socket.IO events, and localization are checked for user-facing changes.
- [ ] Relevant build, lint, unit, E2E, API-contract, and documentation checks were actually run.
- [ ] Deployment topology and known limitations are described accurately.

## 8.5 Testing Guidelines

Use colocated backend `*.spec.ts` for unit/integration behavior and `test/*.e2e-spec.ts` for API-level verification. For an engine capability, mock the `IWhatsAppEngine` contract and test both `whatsapp-web.js` and Baileys on the relevant adapter mapping. For database changes, cover the `data` SQLite and PostgreSQL dialects when SQL or column types differ.

### Suggested targeted test matrix

| Changed area | Regression cases to verify |
| --- | --- |
| API keys and tenants | All five roles; missing/disabled key; `allowedSessions` intersection; Team Leader foreign session; unassigned Agent; Agent's assigned foreign-owner session; `404` non-disclosure; historical tombstone access. |
| Chat receipt and rendering | Inbound event when chats page is closed; persistent row written once; summary and open-thread update; background subscription; reconnect; invalidation of an already-cached thread; correct session/chat IDs. |
| Message phone fields | Direct inbound/outbound, linked-phone echo, group `author`, unknown recipient, unresolved `@lid`, historical records with nulls, incoming history backfill. |
| Message status/mutations | Duplicate engine event, acks before final send save, out-of-order status, rapid edits/reactions, stale retired engine callbacks. |
| Ownership and takeover | Atomic competing claims, renewal, database blip, lease loss, manual stop versus crash, takeover gating, stuck in-flight bulk batches, lifecycle cleanup. |
| Agent template sends | Quota window, concurrency/reservation behavior, `429`, assignment/access failure, normal text/media not counted by template quota. |
| Frontend/i18n | Route access, 401/403/404 errors, loading and reconnect states, all supported locale keys, RTL layout. |

These are **recommended cases for affected work**, not a claim that every case is already covered by an existing test.

### Project commands

```bash
# Run from repository root after installing locked dependencies.
npx tsc --noEmit -p tsconfig.json
npm run lint
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run dashboard:build

# Documentation and external contract checks, when affected:
npm run test:docs -- --runInBand
npm run check:contract-shapes
npm run openapi:check
npm run format:check

# Run only the selected suite while iterating:
npm test -- message.service.spec.ts --runInBand
```

The repository root TypeScript check includes backend test source. Dashboard lint can be run separately with `cd dashboard && npm run lint`. The full suite and some integration/PG checks may require test-specific infrastructure or environment. Use actual command exit codes and logs when reporting results; documentation edits alone do not establish that application tests pass.

## 8.6 Documentation Standards

Document the **implemented behavior**, not a generic architectural pattern. Every new controller route should have accurate DTO and Swagger/OpenAPI documentation. When a change affects external payloads, update the OpenAPI snapshot/SDK contracts and applicable examples. Keep the developer guide, architecture, and deployment documents consistent about supported session topology and security responsibilities.

Code examples must reference existing exported types and the right connection names. Label conceptual snippets as illustrative; do not present an imagined `SessionRepository`, `getDatabaseConfig`, mandatory send queue, or `replicas: 3` as shipped code. When reworking diagrams, draw the real path through `MessageSendService` or `MessageProjector` instead of a single generic `MessageManager`.

For a documentation PR, review localized dashboard text separately from documentation language: updating English Markdown does not complete frontend localization.

## 8.7 Error Handling

Throw NestJS's built-in `HttpException` subclasses or the existing engine/domain error classes. The application uses NestJS's normal error response rather than a global `{ success, data }` envelope.

| Condition | Correct treatment |
| --- | --- |
| API key absent/invalid | `UnauthorizedException` (`401`). |
| Authenticated caller lacks capability | `ForbiddenException` (`403`). |
| Session missing or inaccessible to tenant | Established tenant-aware `NotFoundException` (`404`). |
| Invalid input | `BadRequestException` (`400`) or DTO validation response. |
| Engine temporarily not ready / ownership conflict | Existing mapped conflict exception/status; do not report a false success. |
| Agent stored-template quota exhausted | Existing quota/rate-limit exception (`429`). |
| Adapter cannot implement a capability | Existing engine not-supported error (`501`) when mapped. |
| WhatsApp transport unavailable | Existing engine transport error (`503`) when mapped. |

Use existing error classes from `src/common/errors/` when they match the condition. Log failures with safe context and preserve cause/stack internally without exposing sensitive details to clients. For asynchronous engine events, handle rejected work and avoid crashing or indefinitely blocking subsequent messages for that session.

## 8.8 Environment Setup

### Prerequisites and branch checkout

Follow the repository's `package.json` Node/npm engine requirements and committed lockfile; the current root package specifies Node.js `>=22.13`. Docker and Git are useful for local infrastructure and source management.

```bash
git clone --branch SunProject https://github.com/AbdoHussein1998/OpenWA.git
cd OpenWA
npm ci
npm run dev
```

`npm ci` installs the committed dependency versions. The existing postinstall step applies project-maintained WhatsApp library patches: do not bypass or silently drop it, since adapter send/receive behavior may rely on these patches. Use `npm install` instead only when intentionally changing dependencies and the lockfile.

Configuration is loaded through the project's config and environment-validation code. The project can generate a local configuration on initial boot; use the existing `.env.example` and `src/config/` as the source for **complete** current variable names and defaults. Do not commit actual API keys, database credentials, or WhatsApp auth files.

### Minimal single-replica configuration

```dotenv
NODE_ENV=development
PORT=2785
DATABASE_TYPE=sqlite
DATABASE_NAME=./data/openwa.sqlite
DATABASE_SYNCHRONIZE=false
STORAGE_TYPE=local
STORAGE_LOCAL_PATH=./data/media
REDIS_ENABLED=false
QUEUE_ENABLED=false
ENGINE_TYPE=whatsapp-web.js
SESSION_DATA_PATH=./data/sessions
```

This is an **example profile**, not a complete copy of `.env.example`: the existing config may generate additional local secrets or defaults. Run the migrations rather than assuming `DATABASE_SYNCHRONIZE=true` is suitable for durable data.

### PostgreSQL data connection, Redis, and engine alternatives

```dotenv
# Select PostgreSQL for data; main remains SQLite.
DATABASE_TYPE=postgres
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=openwa
DATABASE_USERNAME=openwa
DATABASE_PASSWORD=<set-a-secret>
DATABASE_SYNCHRONIZE=false

# Optional Redis-backed cache/queues and event fan-out:
REDIS_ENABLED=true
REDIS_HOST=localhost
REDIS_PORT=6379

# Optional browser-free engine on a compatible/authenticated installation:
ENGINE_TYPE=baileys
```

Do not copy placeholder credentials into a real environment. Switching `DATABASE_TYPE` does **not** move Team Leader/Agent identities or API keys out of the `main` SQLite database. Switching `ENGINE_TYPE` does **not** automatically convert or migrate saved auth state between engines.

### Ownership, takeover, and routing variables

`NODE_ID` identifies the owner process (defaults to host identity), and `NODE_URL` optionally supplies its reachable HTTP URL for owner request forwarding. `SESSION_LEASE_TTL_MS` defaults to 60 seconds, `SESSION_LEASE_HEARTBEAT_MS` to 20 seconds, `SESSION_TAKEOVER_SWEEP_MS` to 30 seconds, and `SESSION_PROXY_TIMEOUT_MS` to 60 seconds; see `src/config/` for current parsing and validation. Takeover is gated by `AUTO_START_SESSIONS` and only adopts eligible expired-owner sessions. Keep clocks synchronized wherever more than one node could access the same ownership database.

**These configuration knobs do not authorize running several production replicas.** The current [horizontal-scaling guide](./13-horizontal-scaling.md) explicitly requires a single API replica per session-data volume because other lifecycle, WebSocket security, bulk-send, and tool-execution behavior is still process-local.

## 8.9 Debugging Guide

### Start with the actual execution path

For an HTTP failure, capture the route, request ID, session ID, API-key role (not the key itself), validation result, tenant scope decision, selected capability service, repository connection, and engine readiness. For a NestJS DI failure, check the correct module's `imports`, provider/export configuration, and named TypeORM repository; Python imports alone do not register NestJS providers.

### Chat previews update but messages appear only after opening Chats

Treat the following as **separate checkpoints**, not one broad assumption about WebSocket failure:

1. **Engine callback:** Did `onMessage` / `onMessageCreate` fire while the chats page was closed? Record session ID, normalized chat ID, and WhatsApp message ID (not the message body).
2. **Projection:** Did `MessageProjector` accept the callback from the current engine and current owning node, rather than a stale engine? Was an incoming/echo/history event routed to the correct handler?
3. **Persistence:** Does the expected unique `(sessionId, waMessageId)` row exist in `data.messages`? Check direction, `chatId`, timestamp, and status. A moving chat preview is not proof of a persisted row.
4. **WebSocket:** Was the dashboard socket authenticated and subscribed to the correct session/event while that page was closed? Did it receive the event and use the correct event name and payload?
5. **React Query:** Was the matching `['messages', sessionId, chatId]` cache entry updated or invalidated? Does the event handler update only an already-created thread cache? Was the thread refetched after reconnect?
6. **Render:** Do the displayed thread and chat preview use the same normalized session/chat identity and message ordering/deduplication rules?

**Disambiguating test:** send one new inbound message with the dashboard on an unrelated page, observe engine/projection/DB/socket checkpoints, then open the affected thread and inspect the query key and network history. Repeat after a WebSocket reconnect. Implement the smallest correction at the first stage that fails, rather than adding polling everywhere or forcing the chats page to mount on application startup.

### Missing phone numbers

Check `author` for group messages, real sender/recipient JIDs, `message-phone.util.ts`, and the existing LID resolution path. If a sender is known only as an unresolved `@lid`, null phone columns are a **correct result**, not evidence that message persistence failed. Check outbound send persistence and asynchronous echoes separately.

### Session ownership and failover

Inspect `data.sessions` owner fields (`nodeId`, `nodeUrl`, `leaseExpiresAt`), the local registry, process identity, clock synchronization, ownership heartbeat, and takeover eligibility. A foreign live owner may correctly cause the local engine to be absent; do not restart it without an accepted claim. Distinguish a cleanly stopped session (released claim) from a crashed owner (expired claim), and a transient database-renewal failure from confirmed lease loss.

### Logging and database visibility

```bash
# Backend targeted type-check and tests
npx tsc --noEmit -p tsconfig.json
npm test -- session.service.spec.ts --runInBand

# Docker Compose: confirm the actual service name in your compose file.
docker compose ps
docker compose logs -f openwa-api
```

`DATABASE_LOGGING=true` can print full SQL and bound parameters; use only on a sanitized local dataset and never with real message text, phone numbers, or credentials in production logs.

## 8.10 Performance Best Practices

Use query builder filters and suitable compound indexes for message history and status updates. Avoid an N+1 query loop when existing relationships can be loaded together **within one database**; do not attempt to join `main` and `data` in one TypeORM relation. Bound parallel sends and use the existing pacing/breaker logic instead of unbounded `Promise.all` across chats.

Use `CacheService` helpers for cached state, but always tolerate a cache miss: Redis is optional and not the source of truth. For chat caches, respect session/chat-specific keys and existing event reconciliation; an infinite `staleTime` or disconnected socket can leave a thread stale unless revalidation is implemented intentionally.

Bound resource-heavy engine teardown and media work; a hanging browser or transport must not indefinitely block shutdown or session recovery. Evaluate load and DB write concurrency on the selected SQLite/PostgreSQL profile. Do not infer multi-replica support from the availability of PostgreSQL, S3, Redis, or database owner leases.

## 8.11 Common Gotchas and Troubleshooting

| Symptom | Where to inspect first | Avoid |
| --- | --- | --- |
| QR never appears | Adapter initialization, auth path, Puppeteer/browser if using `whatsapp-web.js`, engine state callbacks, existing session auth | Clearing a real user's auth data as the first step. |
| Session seems disconnected on a second process | Owner lease, local `EngineRegistry`, documented single-replica topology | Starting the same account twice against a shared auth directory. |
| Chat preview changes, thread is empty | `MessageProjector`, DB row, socket subscription, `useChatMessages` cache key | Treating the preview event as proof of thread hydration. |
| Recipient/sender phone is null | `author`, WhatsApp JID kind, LID resolver, actual engine phone visibility | Casting `@lid` digits into phone columns. |
| Team Leader/Agent receives 404 | Principal bindings, owner/assignment, `allowedSessions`, live versus historical route | Returning the foreign session's details to diagnose authorization. |
| Nest cannot inject repository | `TypeOrmModule.forFeature` and `@InjectRepository` both use the correct named connection | Assuming `main` and `data` are interchangeable. |
| Migration fails on SQLite but works on PG | Database driver-specific SQL, migrations and schema state, correct `data`/`main` datasource | Copying Postgres DDL unconditionally into a dual-dialect migration. |
| Duplicate message or lost ack | `(sessionId, waMessageId)` persistence, ack-before-save reconciliation, stale-engine guard | Dropping callbacks without tracing deduplication. |
| Template send blocked for Agent | Tenant assignment, stored-template quota window, reservation/accounting, 429 | Disabling general send safety checks to evade the quota. |
| Docker process restarts or engine crashes | Container logs, mounted auth data, browser memory and patch state, database connectivity | Increasing replicas as a recovery technique. |

For a suspected dependency or WhatsApp protocol regression, verify `package-lock.json`, install-time patch logs, the selected adapter, and the project's existing adapter/spec tests before changing library versions.

## 8.12 Contributing Guide

1. Reproduce the behavior and trace existing frontend → API → service → DB/engine → event/cache flow.
2. Identify the smallest code change and affected database/transport contracts.
3. Add a focused regression test that fails before the fix and succeeds afterward where feasible.
4. Update documentation, OpenAPI/SDKs, and localization when externally visible behavior changes.
5. Run the relevant checks from Section 8.5 and report which passed, failed, or could not run.
6. Open a scoped pull request that distinguishes verified behavior from remaining limitations.

Do not introduce a broad redesign, new dependency, new cross-database FK, or new background worker when the existing service and repository paths already satisfy the requirement.

---

[← 07 - API Collection](./07-api-collection.md) · [Documentation Index](./README.md) · [Next: 09 - Testing Strategy →](./09-testing-strategy.md)
