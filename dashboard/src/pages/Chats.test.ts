// Render smoke test for the Chats page under the bare `node --test` runner (no vitest/jest).
// It exists to catch the classic god-component extraction bugs: a missing prop that crashes the
// render, or a lost provider (QueryClient / Role / Toast / i18n). The page is wrapped in the
// same providers App.tsx uses (QueryClientProvider → RoleProvider → ToastProvider; i18n via the
// side-effect import; Chats uses no router hooks, so no Router is needed) and the backend is
// stubbed at the fetch layer with canned JSON for every endpoint the page hits on mount,
// on chat open, and on send.
//
// Runner constraints honored here: plain .ts with React.createElement (the runner cannot parse
// JSX), loader hooks registered before any app-module import (see test-helpers/register-hooks),
// and JSDOM installed before importing modules that read `window` at import time.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session, Chat, ChatMessage } from '../services/api';
import type { installJsdomGlobals as installJsdomGlobalsFn } from '../test-helpers/jsdom.ts';

// ── Fixtures + fetch stub ────────────────────────────────────────────────────

const SESSION: Session = {
  id: 'session-1',
  name: 'Main',
  status: 'ready',
  phone: '15551234567',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const CHAT: Chat = {
  id: '15550001111@c.us',
  name: 'Alice',
  isGroup: false,
  kind: 'individual',
  unreadCount: 2,
  timestamp: 1_700_000_000,
  lastMessage: 'hello from alice',
};

const DB_MESSAGE: ChatMessage = {
  id: 'db-1',
  waMessageId: 'wamid.1',
  chatId: CHAT.id,
  from: CHAT.id,
  to: 'me',
  body: 'hello from alice',
  type: 'text',
  direction: 'incoming',
  status: 'delivered',
  timestamp: 1_700_000_000,
  createdAt: new Date(1_700_000_000_000).toISOString(),
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// URL router for every endpoint the page (and the hooks/components under it) can hit during the
// smoke flow below. Anything else gets a 404 so an unexpected request fails loudly in the test
// output instead of resolving into a confusing downstream crash.
function installFetchStub(): void {
  const chatId = encodeURIComponent(CHAT.id);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');

    if (method === 'GET' && path === '/api/sessions') return Promise.resolve(jsonResponse([SESSION]));
    if (method === 'GET' && path === '/api/infra/engines/current') {
      return Promise.resolve(jsonResponse({ engineType: 'baileys' }));
    }
    if (method === 'GET' && path === `/api/sessions/${SESSION.id}/chats`) {
      return Promise.resolve(jsonResponse([CHAT]));
    }
    if (method === 'GET' && path.startsWith(`/api/sessions/${SESSION.id}/contacts/profile-pictures`)) {
      return Promise.resolve(jsonResponse({ pictures: {} }));
    }
    if (method === 'GET' && path === `/api/sessions/${SESSION.id}/contacts/${chatId}/profile-picture`) {
      return Promise.resolve(jsonResponse({ url: null }));
    }
    if (method === 'GET' && path.startsWith(`/api/sessions/${SESSION.id}/messages?`)) {
      return Promise.resolve(jsonResponse({ messages: [DB_MESSAGE], total: 1 }));
    }
    if (method === 'GET' && path.startsWith(`/api/sessions/${SESSION.id}/messages/${chatId}/history`)) {
      return Promise.resolve(jsonResponse([]));
    }
    if (method === 'POST' && path === `/api/sessions/${SESSION.id}/chats/read`) {
      return Promise.resolve(jsonResponse({ success: true }));
    }
    if (method === 'POST' && path === `/api/sessions/${SESSION.id}/messages/send-text`) {
      return Promise.resolve(jsonResponse({ messageId: 'wamid.out.1', timestamp: 1_700_000_100 }));
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  };
}

// ── Harness bootstrap ────────────────────────────────────────────────────────

type RTL = typeof import('@testing-library/react');
type ChatsModule = typeof import('./Chats.tsx');
type RoleModule = typeof import('../components/RoleProvider.tsx');
type ToastModule = typeof import('../components/Toast.tsx');

let rtl: RTL;
let Chats: ChatsModule['Chats'];
let RoleProvider: RoleModule['RoleProvider'];
let ToastProvider: ToastModule['ToastProvider'];
let installJsdomGlobals: typeof installJsdomGlobalsFn;
let queryClient: QueryClient | undefined;

before(async () => {
  ({ installJsdomGlobals } = await import('../test-helpers/jsdom.ts'));
  await installJsdomGlobals();
  installFetchStub();
  // RoleProvider initializes from localStorage; 'admin' makes canWrite true so the composer
  // controls render enabled.
  window.localStorage.setItem('openwa_user_role', 'admin');
  // Side-effect import: initializes the real i18n instance with all locales (JSON modules are
  // handled by the registered loader hooks).
  await import('../i18n/index.ts');
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Chats } = await import('./Chats.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
});

function renderChats(): { container: HTMLElement } {
  // Small gcTime so the QueryClient's garbage-collection timers don't hold the test process open.
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        RoleProvider,
        null,
        createElement(ToastProvider, null, createElement(Chats)),
      ),
    ),
  );
}

// ── Smoke test ───────────────────────────────────────────────────────────────

test('Chats renders: session/chat list loads, a chat opens, and a message sends', async () => {
  const { screen, fireEvent, within } = rtl;
  const { container } = renderChats();

  // Sidebar: the session selector shows the stubbed ready session, and the chat list row
  // appears once /sessions and /sessions/:id/chats have resolved.
  await screen.findByText('Main (15551234567)');
  const chatRow = await screen.findByText('Alice');

  // Open the chat: the message thread renders the stubbed DB message (both the DB and the
  // engine-history fetches went through the stub). Scoped to the thread container: the sidebar
  // snippet carries the same lastMessage text, so an unscoped query is a timing coin-flip.
  fireEvent.click(chatRow);
  const thread = container.querySelector('.room-messages') as HTMLElement;
  await within(thread).findByText('hello from alice');

  // Composer: the send button (aria-label = chats.send) and message input are the stable markers.
  const sendButton = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
  const input = screen.getByPlaceholderText('Type a message...') as HTMLInputElement;
  assert.equal(sendButton.disabled, true); // empty input → disabled

  // Type and send: the optimistic bubble appears, then reconciles with the stubbed response
  // (scoped again — the send also promotes the sidebar row to the same snippet text).
  fireEvent.change(input, { target: { value: 'hello back' } });
  assert.equal(sendButton.disabled, false);
  fireEvent.click(sendButton);
  await within(thread).findByText('hello back');
});
