// Which lifecycle actions a session card offers, extracted for direct unit testing (dashboard tests
// cover pure utils only).

import type { Session } from '../services/api.ts';

// Statuses in which the API has an engine loaded for the session. This is the single source of truth
// for the engine-backed actions — Stop, Unlink, and Force-Kill — because they share one precondition:
// something live to act on. Keeping them on one set is what stops a card from offering an action the
// API rejects, and, just as importantly, from offering Start to a session that is already started (the
// API answers 400 and the page then opens a QR modal that can never resolve).
//
// `authenticating` and `action_required` belong here: both hold a live engine — the whatsapp-web.js
// adapter can sit in `authenticating` for 90 seconds, and `action_required` means the engine is
// running but something needs a human. Without them a card in either state offered only Start.
const STARTED_STATUSES = new Set([
  'initializing',
  'connecting',
  'qr_ready',
  'authenticating',
  'ready',
  'action_required',
]);

export function isSessionStarted(status: string): boolean {
  return STARTED_STATUSES.has(status);
}

// Unlink calls POST /sessions/:id/logout, which needs a live engine to send the unlink through — the
// same precondition as Stop, and what the API's own 400 tells the operator.
export function canUnlinkSession(status: string, canWrite: boolean): boolean {
  return canWrite && isSessionStarted(status);
}

// Force-kill is the emergency hatch for a WEDGED engine, so it is offered exactly when a live engine
// exists. It must NOT be offered for FAILED: a terminal failure already evicted the engine, so there
// is nothing left to kill — the card offers reconnect/manual start instead.
export function canForceKillSession(status: string, canWrite: boolean): boolean {
  return canWrite && isSessionStarted(status);
}

// Replace the row matching `updated.id` with the EXACT authoritative response object. The original
// defect was that the page discarded the API response and fabricated `{ status: 'disconnected' }`,
// losing server-owned fields (phone:null, timestamps). Returning the exact object — never a merge —
// is what keeps the local view byte-for-byte with the server's authoritative state.
export function replaceSession(sessions: Session[], updated: Session): Session[] {
  return sessions.map(s => (s.id === updated.id ? updated : s));
}

// The gateway's own stable code SESSION_LOGOUT_INCOMPLETE is the only signal that the session stopped
// locally while the unlink operation stayed incomplete. A reverse-proxy 502 — bare or a JSON body
// without that exact code — must stay generic: the request may never have reached the gateway, so
// nothing was stopped and the "start and retry the logout" guidance would be actively wrong. The code
// is carried on the thrown API error (see services/api.ts), not inferred from a message heuristic.
export function classifyUnlinkError(err: unknown): 'incomplete' | 'generic' {
  const e = err as { code?: string } | null | undefined;
  return e?.code === 'SESSION_LOGOUT_INCOMPLETE' ? 'incomplete' : 'generic';
}
