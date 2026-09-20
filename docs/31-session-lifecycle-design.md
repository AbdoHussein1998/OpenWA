# 31 — Session Lifecycle: Invariant Catalog

> **Branch scope:** `SunProject`. Read this alongside [03 — System Architecture](./03-system-architecture.md), [08 — Development Guidelines](./08-development-guidelines.md), and [13 — Horizontal Scaling](./13-horizontal-scaling.md). The system includes owner leases, takeover, and optional HTTP/event distribution mechanisms; **multi-replica production deployment is not yet a supported topology**. An engine instance and its in-flight control state remain local to a single NestJS process.

> **Status:** living design note. This document maps the race windows the session lifecycle
> defends against to the code that defends them and the spec that pins each one. It is the
> companion to `docs/03` §_Engine Lifecycle State Machine_, which describes the WHAT; this
> describes the WHY-NOT-THE-OBVIOUS-THING. Anchors reference **spec files by name** (stable) —
> not line numbers (they rot).

The lifecycle is split across three files with one rule each:

| File                                                                                | Owns                                                                   |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `session-engine-lifecycle.service.ts` (implementation; verify current file length)                                | Engine creation/initialization, status transitions, teardown           |
| `session-engine-controls.ts`                                                           | Control verbs (including start/stop/logout/forceKill/delete/reconnect) |
| `session-ownership.service.ts` + `src/modules/takeover/session-takeover.service.ts` | Cross-node leases, adoption, orphan reaping                            |

---

## 31.1 The invariant catalog

Each entry: the interleaving that would break a naive implementation → where it is defended →
which spec pins it. **If you change one of these files, re-read the rows that cite it.**

### INV-1 — Double-start cannot orphan the first engine

**Interleaving:** two `POST /start` for the same session race; both pass the "not already
starting" read; two engines come up; one is leaked forever (registry holds the second).
**Defense:** `initializingSessions` is reserved SYNCHRONOUSLY (before any `await`) in
`session-engine-controls.ts` — the second request observes the reservation and fails fast.
**Pinned by:** `session.service.spec.ts` (the maxConcurrent/double-start cases, incl. the concurrent-start
claim-holding verbs at `')() keeps the claim when a concurrent start still holds the session
here'`).
**The naive fix that is wrong:** checking session.status instead — status is written to the DB
and read back with an await in between; the reservation map is the only synchronous view.

### INV-2 — INITIALIZING is persisted before `initialize()`, and retirement can await that write

**Interleaving:** a stop/logout lands while `initialize()` is in flight; the control sees status
`READY` (stale) and skips teardown of an engine that is actually mid-boot.
**Defense:** the INITIALIZING row is written and its promise tracked
(`session-engine-lifecycle.service.ts`, `initializeEngine`); a retiring control awaits the
pending write before deciding what it is retiring.
**Pinned by:** `session.service.spec.ts` (the stop/delete-during-start teardown cases).

### INV-3 — Local engine-generation liveness is re-validated by object identity, not by session id

**Interleaving:** control A starts engine #1; engine #1 fails and is destroyed; control B (a
retry) starts engine #2; a stale callback from #1 arrives and mutates registry state owned by #2.
**Defense:** `EngineRegistry` keys by session id but validates liveness by object identity
(`isLive` / `deleteIfLive`) — a superseded engine's late callback cannot act.
**Pinned by:** `engine-registry.service.spec.ts` (isLive / deleteIfLive cases); the registry
is the single most repeated invariant in the module.

### INV-4 — Init timeout evicts and 504s; init rejection propagates as FAILED

**Interleaving:** whatsapp-web.js calls `page.goto(..., {timeout: 0})` — a hung browser never
rejects, so a plain `await` hangs the start forever.
**Defense:** `Promise.race` deadline in `initializeEngine`; on timeout the engine is evicted +
force-destroyed + status DISCONNECTED + 504 to the caller. A REAL rejection is NOT treated as a
timeout: it propagates so `start()` records FAILED with the reason.
**Pinned by:** `session.service.spec.ts` (start failure-path cases; the timeout/rejection
split lives in `session.service.spec.ts`'s init-timeout describes).
**Do not "simplify" the two paths into one** — the distinction is why a bad proxy config returns
FAILED + reason while a wedged browser returns 504 + eviction.

### INV-5 — Delete racing a start re-purges auth directories after init resolves

**Interleaving:** delete runs (purges dirs, tombstones the row); the in-flight start's
`initialize()` resolves and re-creates the auth dir; a phantom session lingers on disk.
**Defense:** post-init resurrection guards re-check the tombstone and re-purge
(`session-engine-controls.ts` start path, after the awaited init).
**Pinned by:** `session.service.spec.ts` ('tears down the just-initialized engine if a
stop/delete lands during start() — no resurrection to READY').

### INV-6 — Confirmed lease loss retires only the stale node’s local engine; it does not write the peer-owned session row

**Interleaving:** node A holds session X's lease; node B adopts it after A's lease lapses; a
stale in-flight write from A would clobber B's status.
**Defense:** only after ownership loss has been established, `stopOrphanEngines` destroys stale local engines; the session row is the
owning node's alone (`session.service.ts` boot path).
**Pinned by:** `src/modules/takeover/session-takeover.service.spec.ts` +
`session-ownership.service.spec.ts` + `session-ownership-status-fence.spec.ts`.

### INV-7 — FAILED sessions are deliberately NOT adopted by takeover

**Interleaving:** a session that failed on node A (real engine error) would be adopted by node B
and quietly retried, hiding the failure from the operator.
**Defense:** the adoption sweep skips FAILED rows — a human decides.
**Pinned by:** `src/modules/takeover/session-takeover.service.spec.ts` ('skips sessions not
worth resuming: unauthenticated, mid-pairing, or operator-flagged failed').

### INV-8 — Logout teardown races nothing: the browser must be gone before dir removal

**Interleaving:** `client.logout()` chains `authStrategy.logout()` → `fs.rm(userDataDir)` while
the Chromium process still holds file handles → rm fails or races a browser re-write.
**Defense:** the logout path force-destroys the browser first, waits, then removes the dir; the
475-line spec enumerates the interleavings.
**Pinned by:** `logout-teardown-race.spec.ts` — the module's most complete race corpus. Read it
before touching anything in the logout/forceKill path.

### INV-9 — The reconnect loop bounds itself: backoff with jitter, clamp ≤ 1h and ≤ setTimeout's 32-bit range, alert every 5 consecutive attempts

**Defense:** `reconnect-policy.ts` — a pure decision function (5-minute stability reset, loop
alerts) consumed by the lifecycle; the clamps exist because a naive `delay * 2^attempt` reaches
values `setTimeout` silently truncates.
**Pinned by:** `reconnect-policy.spec.ts`.

### INV-10 — Boot auto-start is sequential, staggered (2s per Chromium), and detached from bootstrap

**Why:** ten Chromium instances launching simultaneously on boot would hold the HTTP port closed
for minutes; detaching from bootstrap means the API answers while engines warm.
**Pinned by:** `session.service.spec.ts` (boot auto-start ordering/staggering cases).

---

### INV-11 — A lease renewal error is not itself proof of ownership loss

**Interleaving:** a temporary `data`-database error interrupts a heartbeat while the original
lease remains valid. A naive handler treats the query error as a definitive ownership transfer,
destroys the live engine, or writes an unsolicited session state change.
**Defense to preserve:** separate an *unknown renewal outcome* from a confirmed failed claim;
use the existing ownership service and lease-fencing rules before making a retirement decision.
The local `EngineRegistry` is not an authoritative cross-node ownership table.
**Related existing coverage:** `session-ownership.service.spec.ts` and
`session-ownership-status-fence.spec.ts` (inspect their current cases when editing the renewal path).

### INV-12 — Lifecycle control must enforce tenant scope before exposing or changing a session

**Interleaving:** an authenticated Team Leader or Agent invokes `start`, `stop`, `logout`,
`force-kill`, or `delete` with the UUID of another tenant's session. A role-only check succeeds,
or a forwarded request bypasses the tenant check, and the caller acts on a foreign engine.
**Boundary:** route capability authorization is distinct from `SessionTenantAccessService`'s
live-session access decision. The effective session set is the intersection of the role's
ownership/assignment and any nonempty `allowedSessions` restriction. Deny an inaccessible
session without disclosing that it exists. A historical-session access decision is not a
substitute for the authorization required to operate on a *live* session.
**Testing requirement:** cover each lifecycle mutation across Admin/Operator/Viewer/Team
Leader/Agent roles and foreign/absent session IDs in the applicable guard, controller, and
access-control specs. These are required regression scenarios, **not** claims that a new
`INV-12` test suite already exists.

### INV-13 — Takeover must not replay ambiguous side effects

**Interleaving:** the former owner sends some messages from an in-flight bulk batch, loses
ownership before acknowledging progress, and the new node automatically restarts that batch.
Recipients receive duplicates because the new node cannot know the original send outcome.
**Boundary:** session takeover may restore an eligible authenticated session via the normal
start lifecycle; it does **not** automatically resume an abandoned bulk-send batch. Fail or
reconcile that batch separately, with explicit operator action where necessary.
**Testing requirement:** simulate owner loss after an engine send and before local batch-state
update; verify there is no implicit batch replay. Use the existing bulk-send and takeover
spec files rather than introducing a second lifecycle implementation.

---

## 31.2 Status-transition ownership

Every transition has a known, enumerated set of writers. When debugging a status surprise, find the
writer before anything else:

| Transition                      | Writers                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| → `INITIALIZING`                | `initializeEngine` (persisted before `initialize()`)                                      |
| → `QR_READY` / `AUTHENTICATING` | engine callbacks (wired in the lifecycle delegate), via the registry's liveness check     |
| → `READY`                       | `handleEngineReady` (also drops a recorded failure reason, see INV-7's rationale comment) |
| → `DISCONNECTED`                | init-timeout eviction, graceful stop, puppeteer-death detection                           |
| → `FAILED`                      | four terminal paths only, all ownership-fenced: see below                                 |

`FAILED` is the one worth spelling out, because it is terminal (neither the boot reset nor the
takeover sweep resumes a FAILED row, INV-7) and because more than one path reaches it:

1. `start()`'s own rejection path, when `initializeEngine` throws (`session-engine-controls.ts`).
2. The engine's `onError` callback, which is terminal by definition: it cancels any pending
   reconnect before persisting, because a re-scan is required (`session-engine-event-wiring.ts`).
3. The engine reporting `EngineStatus.FAILED` through `onStateChanged`, which the status map
   forwards verbatim (`session-engine-event-wiring.ts`).
4. A reconnect chain that EXHAUSTS its attempts, so the session is not left silently stuck
   `DISCONNECTED` with no engine (`session-engine-lifecycle.service.ts`).

What still holds, and is load-bearing, is the narrower claim: no reconnect ATTEMPT writes FAILED.
Only the exhaustion of the whole chain does. A loop that marked each failed attempt would turn every
transient network blip into an operator-visible terminal state and defeat INV-7's signal. All four
paths are fenced on `ownsSession`, so a dying generation cannot park a peer's session in a status
nothing resets automatically.

## 31.3 Comments that exist because the obvious fix is wrong

Collected here so they survive refactors of the code around them:

- `session-engine-lifecycle.service.ts` (init deadline region): the do-not-reorder note — the
  ownership re-validation window between the status write and `initialize()` is _narrowed, not
  closed_; moving the re-validation after init reopens INV-2.
- `session-engine-controls.ts` (start): `session.config` is clamped to trusted keys because the
  row is client-writable; an unclamped spread would let a caller smuggle engine options.
- `EngineRegistry`: identity-based `deleteIfLive` rather than `delete(id)` — see INV-3; every
  site that bypassed this in review's history created the same phantom-callback bug.

## 31.4 Operator and developer diagnostic sequence

When a session appears stuck, determine the state writer and the **engine generation** before
forcing a transition. Trace `session-engine-controls.ts` (synchronous start reservation),
`session-engine-lifecycle.service.ts` (pending INITIALIZING write and init deadline),
`EngineRegistry` (identity-based liveness), the owner lease in the `data` database, then any
takeover sweep. A stale callback or an engine missing from **this node's** registry does not
establish that the session is disconnected globally.

For API failures, separate credential/authentication (`401`), missing route capability
(`403`), and a session outside the caller's effective tenant scope (`404`). These are not
alternative spellings for a failed WhatsApp connection. A `504` on a wedged initialization
must not be rewritten to look like an engine rejection; a terminal FAILED condition must not
be silently converted into an automatic takeover candidate.

For manual recovery, use the existing control endpoints and verify that the old engine has
been retired and its lease released or conclusively lost. Avoid direct database status
updates or deletion of auth directories while an engine can still write them. Preserve the
single-replica deployment requirement despite the existence of leases, node URLs and Redis
Socket.IO fan-out.

## 31.5 What this document is NOT

- Not a state machine diagram (docs/03 has it).
- Not an assertion that every suggested regression case above is already present in the test suite.
- Not exhaustive per-file documentation — the source comments carry the local detail; this maps
  the SYSTEM of invariants and where each lives.
- Not a spec: where this document and a spec disagree, the spec is right — fix this document.