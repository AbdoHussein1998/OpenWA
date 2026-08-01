import * as fs from 'fs';
import * as path from 'path';
import type { Agent } from 'https';
import * as qrcode from 'qrcode';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type * as BaileysLib from '@whiskeysockets/baileys';
import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysChannels } from './baileys-channels';
import { BaileysContacts } from './baileys-contacts';
import { BaileysEvents } from './baileys-events';
import { BaileysGroups } from './baileys-groups';
import { BaileysHistory, toUnixSeconds } from './baileys-history';
import { BaileysMessaging } from './baileys-messaging';
import { BaileysStatus } from './baileys-status';
import type { ILogger } from '@whiskeysockets/baileys/lib/Utils/logger.js';
import {
  ChatState,
  Channel,
  ChannelMessage,
  Catalog,
  Contact,
  ContactCard,
  EngineEventCallbacks,
  EngineStatus,
  Group,
  GroupInfo,
  IncomingMessage,
  IWhatsAppEngine,
  Label,
  LocationInput,
  MediaInput,
  MessageReaction,
  MessageResult,
  PaginatedProducts,
  ParticipantOperationResult,
  PollInput,
  Product,
  ProductQueryOptions,
  Status,
  StatusResult,
  ChatSummary,
  StatusPostOptions,
} from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { createLogger } from '../../common/services/logger.service';
import { BaileysAdapterConfig, BaileysLogger } from '../types/baileys.types';
import { BaileysSessionStore } from './baileys-session-store';
import { inboundMediaConcurrency } from './inbound-media-cap';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

/** Linked-device identity shown in WhatsApp (Settings → Linked Devices). The display name is
 * operator-brandable via BAILEYS_BROWSER_NAME; it only applies to pairings made after the change. */
const BAILEYS_BROWSER: [string, string, string] = [
  process.env.BAILEYS_BROWSER_NAME?.trim() || 'OpenWA',
  'Chrome',
  '120.0.0',
];

/**
 * How long logout() waits for WhatsApp to acknowledge the `remove-companion-device` IQ. Completion of
 * an engine-native unlink requires a tagged IQ result from the server (NOT a WebSocket write flush),
 * so this bound is the difference between a 502 (operation incomplete) and a 200 (unlink completed).
 * Set above the typical round-trip but well under the service's 10s teardown deadline so a wedged
 * transport surfaces as a retryable 502 instead of wedging the session.
 */
const BAILEYS_LOGOUT_ACK_TIMEOUT_MS = 8_000;

/**
 * Build the Node-layer agent for a session egress proxy (#859). Both the WhatsApp WebSocket
 * (`agent`) and media up/downloads (`fetchAgent`) ride it; credentials stay in the URL and are
 * authenticated on the socket itself, so none of the Chromium CDP auth timing the wwjs engine is
 * exposed to applies here. The scheme set matches the create-session DTO validator; anything else
 * (a pre-validation DB row) throws, failing the session closed rather than silently going direct.
 */
export function createProxyAgent(proxyUrl: string): Agent {
  const { protocol } = new URL(proxyUrl);
  if (protocol === 'http:' || protocol === 'https:') {
    return new HttpsProxyAgent(proxyUrl);
  }
  if (protocol === 'socks4:' || protocol === 'socks5:') {
    return new SocksProxyAgent(proxyUrl);
  }
  throw new Error(`Unsupported proxy protocol for the baileys engine: ${protocol}`);
}

/** Fully silent logger so Baileys does not spam stdout; diagnostics flow via connection.update. */
function createSilentLogger(): BaileysLogger {
  const noop = (): void => {};
  const logger: BaileysLogger = {
    level: 'silent',
    child: () => logger,
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
  return logger;
}

const BAILEYS_LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'];

/**
 * Baileys logger, silent by default. Set `BAILEYS_LOG_LEVEL` (trace|debug|info|warn|error) to surface
 * Baileys' own diagnostics - the history/app-state sync decision flow ("awaiting notification", "App
 * state sync complete", MAC errors) at debug/info, and the raw decoded WA wire frames at trace. Emits
 * JSON lines to stdout (context "baileys-wire") independent of the app log level, so a run can be
 * captured with `BAILEYS_LOG_LEVEL=trace node dist/main > baileys-wire.log`.
 */
function createBaileysLogger(): BaileysLogger {
  const configured = (process.env.BAILEYS_LOG_LEVEL ?? 'silent').toLowerCase();
  if (!BAILEYS_LOG_LEVELS.includes(configured)) {
    return createSilentLogger();
  }
  const threshold = BAILEYS_LOG_LEVELS.indexOf(configured);
  const write =
    (lvl: string) =>
    (obj: unknown, msg?: string): void => {
      if (BAILEYS_LOG_LEVELS.indexOf(lvl) < threshold) {
        return;
      }
      const rec =
        typeof obj === 'string' ? { msg: obj } : { ...(obj as Record<string, unknown>), ...(msg ? { msg } : {}) };
      process.stdout.write(
        JSON.stringify({ ts: new Date().toISOString(), level: lvl, context: 'baileys-wire', ...rec }) + '\n',
      );
    };
  const logger: BaileysLogger = {
    level: configured,
    child: () => logger,
    trace: write('trace'),
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
  };
  return logger;
}

export class BaileysAdapter implements IWhatsAppEngine {
  /** A close this long after the previous close means the connection had been healthy in between —
   *  the backoff counter restarts from scratch instead of inheriting an old incident's attempts. */
  private static readonly RECONNECT_STABILITY_RESET_MS = 5 * 60_000;

  private readonly logger = createLogger('BaileysAdapter');
  // Bound concurrent inbound media downloads: each materialises a full decrypted buffer in heap, so an
  // unbounded fire-and-forget loop lets a sender flood the gateway with N parallel multi-MB allocations.
  private readonly inboundLimiter = new ConcurrencyLimiter(
    inboundMediaConcurrency(),
    // Queue cap == active slots: beyond (active + queued) concurrent media messages, reject instead of
    // parking, so a burst can't grow heap without bound (each parked closure holds the message).
    inboundMediaConcurrency(),
  );
  private readonly authPath: string;
  private readonly sessionStore: BaileysSessionStore;
  private readonly groups: BaileysGroups;
  private readonly messaging: BaileysMessaging;
  private readonly contacts: BaileysContacts;
  private readonly statusOps: BaileysStatus;
  private readonly channels: BaileysChannels;
  private readonly history: BaileysHistory;
  private readonly events: BaileysEvents;
  private sock: WASocket | null = null;
  private status: EngineStatus = EngineStatus.DISCONNECTED;
  private qrCode: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  private callbacks: EngineEventCallbacks = {};
  private intentionalClose = false;
  private connecting = false;
  /** Unix-seconds timestamp of the last 'open' connection.update, used to distinguish a genuinely
   *  live message misfiled as 'append' (see BaileysEvents.handleMessagesUpsert) from real history backfill. */
  private connectedAt = 0;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  /** Live-call cache handle — the map is owned by the events delegate (call events + rejectCall);
   *  lifecycle teardown clears it so a late rejectCall() reports not-found on a dead socket. */
  private get liveCalls(): Map<string, { callFrom: string; expiresAt: number }> {
    return this.events.liveCalls;
  }
  /** Date.now() of the last close that scheduled a reconnect — input to the stability reset. */
  private lastConnectionCloseAt = 0;
  /** Lazily loaded @whiskeysockets/baileys module (ESM-only; loaded on first connect, not at boot). */
  private lib?: typeof BaileysLib;

  private async loadLib(): Promise<typeof BaileysLib> {
    return (this.lib ??= await import('@whiskeysockets/baileys'));
  }

  constructor(private readonly config: BaileysAdapterConfig) {
    // Isolate each session's auth state under its own subdirectory of the shared auth dir.
    this.authPath = path.join(config.authDir, config.sessionId);
    this.sessionStore = new BaileysSessionStore(config.lidMappingStore, config.sessionId);
    // Constructed before messaging: the messaging delegate's own-send echo maps through
    // events.mapMessage (and lifecycle teardown clears the live-call cache via the getter above).
    // An object-literal getter's `this` is the literal itself, so the live connectedAt read goes
    // through an arrow closure that captures the adapter.
    const connectedAt = (): number => this.connectedAt;
    this.events = new BaileysEvents({
      getSocket: () => this.sock!,
      getSocketOrNull: () => this.sock,
      logger: this.logger,
      toNeutralJid: jid => this.sessionStore.toNeutralJid(jid),
      normalizedSelfJid: () => this.normalizedSelfJid(),
      loadLib: () => this.loadLib(),
      get connectedAt() {
        return connectedAt();
      },
      inboundLimiter: this.inboundLimiter,
      recordKeyLidMappings: key => this.sessionStore.recordKeyLidMappings(key),
      recordMessage: msg => this.sessionStore.recordMessage(msg),
      recordMessageEdit: (chatId, messageId, text) => this.sessionStore.recordMessageEdit(chatId, messageId, text),
      putStoredMessage: msg => this.config.messageStore?.put(this.config.dbSessionId, msg),
      getOnMessage: () => this.callbacks.onMessage,
      getOnMessageCreate: () => this.callbacks.onMessageCreate,
      getOnMessageRevoked: () => this.callbacks.onMessageRevoked,
      getOnMessageEdited: () => this.callbacks.onMessageEdited,
      getOnMessageReaction: () => this.callbacks.onMessageReaction,
      getOnMessageAck: () => this.callbacks.onMessageAck,
      getOnGroupEvent: () => this.callbacks.onGroupEvent,
      getOnCall: () => this.callbacks.onCall,
    });
    this.groups = new BaileysGroups({
      ensureReady: () => this.ensureReady(),
      getSocket: () => this.sock!,
      logger: this.logger,
      toNeutralJid: jid => this.sessionStore.toNeutralJid(jid),
      toEngineJid: jid => this.sessionStore.toEngineJid(jid),
      normalizedSelfJid: () => this.normalizedSelfJid(),
    });
    this.messaging = new BaileysMessaging({
      ensureReady: () => this.ensureReady(),
      getSocket: () => this.sock!,
      logger: this.logger,
      toNeutralJid: jid => this.sessionStore.toNeutralJid(jid),
      toEngineJid: jid => this.sessionStore.toEngineJid(jid),
      getEphemeralExpiration: chatId => this.sessionStore.getEphemeralExpiration(chatId),
      toUnixSeconds,
      loadLib: () => this.loadLib(),
      putStoredMessage: msg => this.config.messageStore?.put(this.config.dbSessionId, msg),
      getStoredMessage: messageId => this.config.messageStore?.getMessage(this.config.dbSessionId, messageId),
      getOnMessageCreate: () => this.callbacks.onMessageCreate,
      mapMessage: (msg, contentType, opts) => this.events.mapMessage(msg, contentType, opts),
    });
    this.contacts = new BaileysContacts({
      ensureReady: () => this.ensureReady(),
      getSocket: () => this.sock!,
      logger: this.logger,
      normalizedSelfJid: () => this.normalizedSelfJid(),
      listContacts: () => this.sessionStore.listContacts(),
      findContact: contactId => this.sessionStore.findContact(contactId),
      resolvePhone: contactId => this.sessionStore.resolvePhone(contactId),
      listChats: () => this.sessionStore.listChats(),
      lastMessage: chatId => this.sessionStore.lastMessage(chatId),
    });
    this.statusOps = new BaileysStatus({
      ensureReady: () => this.ensureReady(),
      getSocket: () => this.sock!,
      toEngineJid: jid => this.sessionStore.toEngineJid(jid),
      normalizedSelfJid: () => this.normalizedSelfJid(),
      toUnixSeconds,
    });
    this.channels = new BaileysChannels({
      ensureReady: () => this.ensureReady(),
      getSocket: () => this.sock!,
    });
    this.history = new BaileysHistory({
      getSocket: () => this.sock!,
      logger: this.logger,
      toNeutralJid: jid => this.sessionStore.toNeutralJid(jid),
      normalizedSelfJid: () => this.normalizedSelfJid(),
      loadLib: () => this.loadLib(),
      recordMessage: msg => this.sessionStore.recordMessage(msg),
      upsertContacts: records => this.sessionStore.upsertContacts(records),
      upsertChats: records => this.sessionStore.upsertChats(records),
      extractEphemeralDuration: msg => this.sessionStore.extractEphemeralDuration(msg),
      getOnHistoryMessages: () => this.callbacks.onHistoryMessages,
    });
  }

  // ----- Lifecycle -----

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    // Single-use after teardown: disconnect()/destroy()/forceDestroy()/logout() set this latch, and
    // it must NOT be re-armed here. A retired adapter (e.g. one whose session was stopped/deleted
    // during the service's pre-initialize window) would otherwise open a fresh socket no caller is
    // tracking. A new adapter starts with the latch false, so the first initialize() proceeds; a
    // later teardown leaves it true for the adapter's lifetime. connectInner() re-checks the latch
    // after its auth/version awaits as a fence against teardown during those I/O steps.
    if (this.intentionalClose) {
      return;
    }
    try {
      await this.connect();
    } catch (err) {
      this.setStatus(EngineStatus.FAILED);
      this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private async connect(): Promise<void> {
    // I4: in-flight guard — skip if a connect() is already in progress.
    if (this.connecting) {
      return;
    }
    this.connecting = true;
    try {
      await this.connectInner();
    } finally {
      this.connecting = false;
    }
  }

  private async connectInner(): Promise<void> {
    this.setStatus(EngineStatus.INITIALIZING);
    // Build the egress proxy agent BEFORE any auth-state I/O so an unusable proxy value fails the
    // session (engine_error) instead of silently connecting direct (#859).
    let proxyAgent: Agent | undefined;
    if (this.config.proxyUrl) {
      proxyAgent = createProxyAgent(this.config.proxyUrl);
      const { protocol, host } = new URL(this.config.proxyUrl);
      // Credential-stripped, matching the wwjs adapter's log line (#628).
      this.logger.log(`Using proxy: ${protocol}//${host}`, { sessionId: this.config.sessionId });
    }
    const b = await this.loadLib();
    const { state, saveCreds } = await b.useMultiFileAuthState(this.authPath);
    const { version } = await b.fetchLatestBaileysVersion();
    // BaileysLogger matches ILogger exactly; cast needed because the module resolves the type
    // through a deep import path that TypeScript does not auto-unify here. Shared by the key
    // store wrapper below and the socket itself, rather than constructing two instances.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const baileysLogger = createBaileysLogger() as unknown as ILogger;

    // Wrap the raw file-backed signal key store with Baileys' own official caching layer.
    // Without it, every session read/write hits disk directly with no protection against a
    // write-then-immediate-read race — observed here as a freshly-established Signal session
    // appearing "missing" moments later, forcing Baileys to discard it and start a brand new
    // PreKey handshake on the very next send (visible as repeated "Closing session" log spam and
    // the recipient stuck on "waiting for this message" until a slow WhatsApp-side retry rescues
    // it). makeCacheableSignalKeyStore keeps the just-written state visible in memory immediately,
    // regardless of disk I/O timing.
    state.keys = b.makeCacheableSignalKeyStore(state.keys, baileysLogger);

    // C2: resurrect-after-stop guard — if disconnect/logout/destroy ran during the awaits above,
    // bail now so we don't create a live socket for a session that was intentionally stopped.
    if (this.intentionalClose) {
      return;
    }

    // An internal reconnect (transient drop) overwrites this.sock WITHOUT going through
    // disconnect/logout/destroy, so the previous socket's WebSocket and the 13 ev listeners we
    // register below would leak on every reconnect. Tear the prior socket down first. Detach OUR
    // connection.update listener BEFORE end(): Baileys' own end() synchronously emits a synthetic
    // connection.update {connection:'close'}, which — if still wired — would re-enter
    // handleConnectionUpdate and schedule a spurious second reconnect.
    const previous = this.sock;
    if (previous) {
      try {
        previous.ev.removeAllListeners('connection.update');
        previous.ev.removeAllListeners('creds.update');
        previous.ev.removeAllListeners('messages.upsert');
        previous.ev.removeAllListeners('messages.update');
        previous.ev.removeAllListeners('contacts.upsert');
        previous.ev.removeAllListeners('contacts.update');
        previous.ev.removeAllListeners('chats.upsert');
        previous.ev.removeAllListeners('chats.update');
        previous.ev.removeAllListeners('messaging-history.set');
        previous.ev.removeAllListeners('lid-mapping.update');
        previous.ev.removeAllListeners('group-participants.update');
        previous.ev.removeAllListeners('groups.update');
        previous.ev.removeAllListeners('call');
        void previous.end(undefined);
      } catch {
        // end() may already have run from Baileys' own close handler — a safe no-op.
      }
    }

    const sock = b.default({
      auth: state,
      version,
      browser: BAILEYS_BROWSER,
      printQRInTerminal: false,
      // Session egress proxy (#859): the WS and media transfers share one agent; undefined = direct.
      agent: proxyAgent,
      fetchAgent: proxyAgent,
      // Enable the initial sync. Baileys defaults `shouldSyncHistoryMessage` to `() => !!syncFullHistory`,
      // so leaving both unset disables ALL history + app-state sync - no contacts, chats, recent history,
      // or lid->phone mappings ever arrive (the address-book app-state sync only runs once history sync is
      // enabled; see WhiskeySockets/Baileys Socket/index.js + Socket/chats.js). Returning true enables it
      // while keeping the full-archive download opt-in: with syncFullHistory false WhatsApp sends the
      // RECENT window + the full contact/app-state snapshot, not the entire message history.
      shouldSyncHistoryMessage: () => true,
      syncFullHistory: process.env.BAILEYS_SYNC_FULL_HISTORY === 'true',
      // Baileys defaults this to `async () => undefined` (Defaults/index.js). Without a real
      // implementation, WhatsApp's message-retry protocol — triggered whenever a recipient's client
      // fails to decrypt on the first attempt — has nothing to resend, so the recipient is stuck on
      // "waiting for this message" indefinitely instead of the retry resolving it within seconds.
      // Backed by the same messageStore used for reply/forward/react/delete-by-id.
      getMessage: async key => {
        if (!key.id) {
          return undefined;
        }
        const stored = await this.config.messageStore?.getMessage(this.config.dbSessionId, key.id);
        return stored?.message ?? undefined;
      },
      logger: baileysLogger,
    });
    this.sock = sock;

    sock.ev.on('creds.update', () => void saveCreds());
    sock.ev.on('connection.update', update => this.handleConnectionUpdate(update));
    sock.ev.on('messages.upsert', event => this.events.handleMessagesUpsert(event));
    sock.ev.on('messages.update', updates => this.events.handleMessagesUpdate(updates));
    sock.ev.on('contacts.upsert', contacts => {
      this.events.logContactEvent('contacts.upsert', contacts);
      this.sessionStore.upsertContacts(contacts);
    });
    sock.ev.on('contacts.update', updates => {
      this.events.logContactEvent('contacts.update', updates);
      this.sessionStore.upsertContacts(updates);
    });
    sock.ev.on('chats.upsert', chats => {
      this.logger.debug('Baileys chats event', { action: 'baileys_chats', event: 'upsert', count: chats?.length ?? 0 });
      this.sessionStore.upsertChats(chats);
    });
    sock.ev.on('chats.update', updates => {
      this.logger.debug('Baileys chats event', {
        action: 'baileys_chats',
        event: 'update',
        count: updates?.length ?? 0,
      });
      this.sessionStore.upsertChats(updates);
    });
    sock.ev.on('group-participants.update', event => this.events.handleGroupParticipantsUpdate(event));
    sock.ev.on('groups.update', updates => this.events.handleGroupsUpdate(updates));
    sock.ev.on('messaging-history.set', history => {
      this.sessionStore.upsertContacts(history.contacts);
      this.sessionStore.upsertChats(history.chats);
      this.sessionStore.addLidMappings(history.lidPnMappings ?? []);
      void this.history.captureHistoryMessages(history.messages ?? []);
      this.logger.debug('History sync received', {
        action: 'baileys_history_set',
        sessionId: this.config.sessionId,
        syncType: history.syncType,
        isLatest: history.isLatest,
        progress: history.progress,
        chats: history.chats?.length ?? 0,
        messages: history.messages?.length ?? 0,
        contacts: history.contacts?.length ?? 0,
        namedContacts: history.contacts?.filter(c => c.name || c.notify).length ?? 0,
        lidContacts: history.contacts?.filter(c => c.lid).length ?? 0,
        lidPnMappings: history.lidPnMappings?.length ?? 0,
      });
    });
    // WhatsApp pushes this when a lid<->phone mapping is learned (renamed from the pre-v7
    // 'chats.phoneNumberShare' event, whose { lid, jid } payload this shape directly replaces).
    sock.ev.on('lid-mapping.update', ({ lid, pn }) => this.sessionStore.addLidMappings([{ lid, pn }]));
    sock.ev.on('call', calls => this.events.handleCallEvents(calls));
  }

  private handleConnectionUpdate(update: {
    connection?: string;
    qr?: string;
    lastDisconnect?: { error?: unknown };
  }): void {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      // Baileys hands us the raw QR ref string; render it to a PNG data URL so the stored
      // value matches the whatsapp-web.js engine's contract (the dashboard does <img src={qrCode}>).
      void this.handleQrCode(qr);
    }

    if (connection === 'connecting') {
      this.setStatus(EngineStatus.INITIALIZING);
    }

    if (connection === 'open') {
      this.qrCode = null;
      this.phoneNumber = this.extractPhone(this.sock?.user?.id);
      this.pushName = this.sock?.user?.name ?? null;
      // I4: reset the reconnect counter on a successful connection.
      this.reconnectAttempts = 0;
      // Small backward buffer for clock skew between this host and WhatsApp's server (messageTimestamp
      // is WA's clock, Date.now() is ours) — without it, a message sent right at reconnect time could
      // land a couple seconds "before" connectedAt and be misjudged as history.
      this.connectedAt = Math.floor(Date.now() / 1000) - 10;
      this.setStatus(EngineStatus.READY);
      this.callbacks.onReady?.(this.phoneNumber ?? '', this.pushName ?? '');
      // Backfill names the initial sync skipped (see hydrateNames).
      void this.history.hydrateNames();
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
        ?.statusCode;

      if (this.intentionalClose) {
        this.setStatus(EngineStatus.DISCONNECTED);
        return;
      }

      if (statusCode === this.lib?.DisconnectReason.loggedOut) {
        // Credentials invalidated — terminal. Re-linking requires a fresh QR/pairing, so the now-dead
        // multi-file auth dir MUST be wiped: otherwise the next connect() reloads the stale creds and
        // Baileys silently retries them instead of emitting a new QR, leaving the session stuck (no QR).
        void this.handleRemoteLoggedOut();
        return;
      }

      if (statusCode === (this.lib?.DisconnectReason.connectionReplaced ?? 440)) {
        // Another live instance took over this account. Reconnecting
        // would fight it — two instances endlessly replacing each other — so this is terminal:
        // the operator stops the other instance, then starts this session again (onError = terminal
        // + evict in the session service). Auth state is NOT cleared: the link itself is still valid.
        this.setStatus(EngineStatus.FAILED);
        this.liveCalls.clear(); // terminal close: dead call handles, like the loggedOut branch above
        this.callbacks.onError?.(
          'Connection replaced by another instance (440) — stop the other instance, then start this session again',
        );
        return;
      }

      if (statusCode === (this.lib?.DisconnectReason.forbidden ?? 403)) {
        // The account itself was rejected by WhatsApp (banned/blocked — an authorization-level
        // refusal that must not be retried). Retrying forever is pointless and risks worsening
        // the account's standing, so this is terminal like 440. Auth state is NOT cleared (unlike
        // 401): this is an account-level refusal, not dead credentials — the operator keeps the auth
        // files for inspection and can retry manually once the account issue is resolved.
        this.setStatus(EngineStatus.FAILED);
        this.liveCalls.clear(); // terminal close: dead call handles, like the loggedOut branch above
        this.callbacks.onError?.(
          'Account rejected by WhatsApp (403) — the number is likely banned or blocked; reconnecting will not help',
        );
        return;
      }

      // Every other close (408/411/428/500/503/515/undefined) is transient: reconnect with capped
      // backoff and NO attempt ceiling — a long network outage must
      // not kill the session. The counter resets on 'open' and via the stability window below.
      // Do NOT fire onDisconnected here; this is a transient drop, not a terminal disconnect.
      this.logger.log('Baileys connection dropped; reconnecting', { statusCode });

      // The socket is dead NOW, but the reconnect attempt only runs after the backoff delay below
      // (up to 60 s + jitter; connectInner's own setStatus(INITIALIZING) fires just before the new
      // socket is created). Staying READY across that window makes probeLiveness() report a live
      // session and lets sends fail against the dead socket, so drop to INITIALIZING here — the
      // 'open' branch restores READY. setStatus no-ops on an unchanged status, so the duplicate
      // closes Baileys can emit per drop do not flap onStateChanged.
      this.setStatus(EngineStatus.INITIALIZING);

      // Duplicate close while a reconnect timer is already pending — ignore it WITHOUT burning an
      // attempt (Baileys can emit more than one close per drop; the increment must come after this).
      if (this.reconnectTimer) {
        return;
      }

      // Stability reset: a close >5 min after the previous one means the connection had been
      // healthy in between — start the backoff fresh instead of inheriting the old counter.
      const now = Date.now();
      if (now - this.lastConnectionCloseAt > BaileysAdapter.RECONNECT_STABILITY_RESET_MS) {
        this.reconnectAttempts = 0;
      }
      this.lastConnectionCloseAt = now;
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule the next reconnect attempt with capped exponential backoff (1 s doubling up to a 60 s
   * cap, plus up to 1 s jitter). Deliberately NO attempt ceiling: transient drops retry forever —
   * only loggedOut (401), forbidden (403), and connectionReplaced (440) are terminal. A connect()
   * failure inside the attempt is just a failed attempt: warn and schedule the next one.
   */
  private scheduleReconnect(): void {
    if (this.intentionalClose || this.reconnectTimer) {
      return;
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(60_000, 1_000 * 2 ** (this.reconnectAttempts - 1)) + Math.floor(Math.random() * 1000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.intentionalClose) {
        return; // stopped while waiting — abort
      }
      void this.connect().catch(err => {
        // A failed attempt (e.g. fetchLatestBaileysVersion offline mid-outage) is NOT terminal —
        // the outage may outlast any fixed attempt budget, so schedule the following attempt.
        this.logger.warn('Baileys reconnect attempt failed; will retry', {
          attempt: this.reconnectAttempts,
          error: err instanceof Error ? err.message : String(err),
        });
        this.scheduleReconnect();
      });
    }, delay);
  }

  /** Render the raw Baileys QR ref to a PNG data URL, then publish it (mirrors the whatsapp-web.js engine). */
  private async handleQrCode(qr: string): Promise<void> {
    try {
      this.qrCode = await qrcode.toDataURL(qr);
      this.setStatus(EngineStatus.QR_READY);
      this.callbacks.onQRCode?.(this.qrCode);
    } catch (error) {
      this.logger.error('Error generating QR code', String(error));
    }
  }

  disconnect(): Promise<void> {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    void this.sock?.end(undefined);
    this.sock = null;
    // Cached call handles die with the socket — drop them so a later rejectCall() reports
    // not-found instead of acting on a closed connection.
    this.liveCalls.clear();
    this.setStatus(EngineStatus.DISCONNECTED);
    return Promise.resolve();
  }

  async logout(): Promise<void> {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    // Capture the exact live socket. Without one the unlink cannot be sent, and an optional-chained
    // send would resolve as though it had been — reporting a confirmed unlink, writing the audit row,
    // and then wiping the on-disk credentials, leaving the device linked server-side with nothing
    // left to retry with. Reachable: a WhatsApp-side logout nulls the socket while the engine stays
    // registered for the whole reconnect backoff.
    const sourceSock = this.sock;
    if (!sourceSock) {
      throw new Error('No live WhatsApp socket — the unlink was not sent');
    }

    try {
      // Completion of an engine-native unlink requires a tagged IQ result from WhatsApp — Baileys'
      // own sock.logout() resolves on a WebSocket write flush (NOT an IQ ack) and transmits nothing
      // at all when creds.me is unset, so a resolved promise proves nothing about the unlink. Use
      // the public query() surface against the pinned `remove-companion-device` node instead.
      const b = await this.loadLib();
      const jid = sourceSock.user?.id;
      if (!jid) {
        // The companion identity is required to address the unlink; without it nothing is sent.
        throw new Error('No linked companion identity — the unlink was not sent');
      }
      const response: unknown = await sourceSock.query(
        {
          tag: 'iq',
          attrs: { to: b.S_WHATSAPP_NET, type: 'set', id: sourceSock.generateMessageTag(), xmlns: 'md' },
          content: [{ tag: 'remove-companion-device', attrs: { jid, reason: 'user_initiated' } }],
        },
        BAILEYS_LOGOUT_ACK_TIMEOUT_MS,
      );
      if (!response) {
        // query() resolved without a result — WhatsApp did not acknowledge the unlink request.
        throw new Error('WhatsApp did not acknowledge the unlink request');
      }

      // Acknowledged. End/null the captured socket, clear live call handles, and drop to
      // DISCONNECTED before the awaited cleanup so no send/path observes a half-torn-down socket.
      this.localSocketShutdown(sourceSock);
      await this.config.messageStore?.clearSession(this.config.dbSessionId).catch(() => undefined);
      // Wipe the multi-file auth dir so a fresh link starts clean — stale creds would otherwise be
      // reloaded on the next connect() and block re-linking (Baileys retries them, no QR emitted).
      // A removal failure propagates: completion requires cleanup, so the operation is incomplete.
      await this.clearAuthState();
    } catch (err) {
      // EVERY failure exit (missing identity, query rejection/timeout, empty response, OR a later
      // auth removal failure) still stops sourceSock locally so no engine/socket orphan is left in
      // the service map after it evicts the engine on 502. Failure before acknowledgement must NOT
      // remove auth state — the link may still be valid server-side, and the creds are needed to
      // retry. localSocketShutdown is identity-safe: it only nulls this.sock if it still points at
      // sourceSock (a concurrent reconnect may have already swapped in a fresh socket).
      this.localSocketShutdown(sourceSock);
      throw err;
    }
  }

  /**
   * Identity-safe local shutdown of a captured socket: clears the reconnect timer, ends the socket,
   * clears cached live call handles, drops to DISCONNECTED, and nulls `this.sock` ONLY if it still
   * points at the same object (a concurrent reconnect could have swapped in a fresh one). Called at
   * every logout exit so the service's 502 genuinely means "stopped locally, operation incomplete".
   */
  private localSocketShutdown(sourceSock: WASocket): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    try {
      void sourceSock.end(undefined);
    } catch {
      // end() may already have run from Baileys' own close handler — a safe no-op.
    }
    // Cached call handles die with the connection — drop them so a later rejectCall() reports
    // not-found (404) instead of acting on a dead socket (mirrors disconnect/destroy).
    this.liveCalls.clear();
    if (this.sock === sourceSock) {
      this.sock = null;
    }
    this.setStatus(EngineStatus.DISCONNECTED);
  }

  /**
   * Handle a WhatsApp-originated `loggedOut` (401) close: the credentials were invalidated server-side
   * and re-linking requires a fresh QR/pairing, so the now-dead multi-file auth dir MUST be wiped —
   * otherwise the next connect() reloads the stale creds and Baileys silently retries them instead of
   * emitting a QR, leaving the session stuck (no QR).
   *
   * The status/socket/live-call teardown happens SYNCHRONOUSLY before any await so the session
   * watchdog never processes a READY socket that is already dead. The strict auth removal is then
   * awaited as a tracked cleanup (Task 5's onCredentialTeardownStarted registers it under the session
   * NAME). On success the engine reports DISCONNECTED + onDisconnected('logged out'); on failure it
   * reports FAILED + onError (terminal — a reconnect with known-invalid auth would loop forever).
   */
  private async handleRemoteLoggedOut(): Promise<void> {
    // Synchronous teardown BEFORE any await.
    this.setStatus(EngineStatus.DISCONNECTED);
    const dead = this.sock;
    this.sock = null;
    // Cached call handles die with the connection — drop them so a later rejectCall() reports
    // not-found (404) instead of acting on a dead socket (mirrors disconnect/logout/destroy).
    this.liveCalls.clear();
    void dead?.end(undefined);

    const cleanup = (async (): Promise<void> => {
      try {
        await this.clearAuthState();
      } catch (err) {
        // A failed credential removal is terminal: report FAILED + onError instead of looking like a
        // clean disconnect (the credentials did not actually get wiped).
        this.setStatus(EngineStatus.FAILED);
        this.callbacks.onError?.(
          `Logged out by WhatsApp, but the local credential cleanup failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
      this.callbacks.onDisconnected?.('logged out');
    })();
    // Register the destructive promise the instant it begins (NOT guarded on this engine still being
    // live): the rm targets the session NAME's auth dir and would race a (re)created session under
    // that same name. tracked under the captured name, settled regardless of the outcome.
    this.callbacks.onCredentialTeardownStarted?.(cleanup);
    await cleanup;
  }

  /**
   * Delete this session's on-disk multi-file auth state (`authDir/sessionId`). Required after a terminal
   * logout: Baileys would otherwise reload the now-invalid creds on the next connect() and retry them
   * instead of emitting a fresh QR, leaving re-linking stuck. `force` makes a missing dir a no-op.
   * Logs the outcome and RETHROWS on failure: completion of an engine-native unlink (logout 200) AND
   * the loggedOut close path both require cleanup, so a removal failure must propagate (the operation
   * is incomplete), not be swallowed.
   */
  private async clearAuthState(): Promise<void> {
    try {
      await fs.promises.rm(this.authPath, { recursive: true, force: true });
      this.logger.log('Cleared Baileys auth state', { authPath: this.authPath });
    } catch (err) {
      this.logger.warn('Failed to clear Baileys auth state', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  destroy(): Promise<void> {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    void this.sock?.end(undefined);
    this.sock = null;
    this.liveCalls.clear();
    this.setStatus(EngineStatus.DISCONNECTED);
    return Promise.resolve();
  }

  // Baileys has no separate Chromium process to SIGKILL (destroy() already ends the socket
  // synchronously), so a force-destroy is just a destroy.
  forceDestroy(): Promise<void> {
    return this.destroy();
  }

  // ----- Status -----

  getStatus(): EngineStatus {
    return this.status;
  }

  /**
   * Cheap local liveness check for the session watchdog. Genuine dead-connection detection is owned
   * by Baileys' built-in keepalive, which surfaces a close event (408) within ~35 s of a silent
   * drop — and the close handler above drops the status to INITIALIZING for the whole reconnect
   * backoff, so READY + a live socket is sufficient here.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async probeLiveness(): Promise<boolean> {
    return this.status === EngineStatus.READY && this.sock != null;
  }

  getQRCode(): string | null {
    return this.qrCode;
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.sock) {
      throw new EngineNotReadyError('Cannot request a pairing code before the engine is initialized.');
    }
    return this.sock.requestPairingCode(phoneNumber);
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getPushName(): string | null {
    return this.pushName;
  }

  // ----- Messaging -----

  async sendTextMessage(chatId: string, text: string, mentions?: string[]): Promise<MessageResult> {
    return this.messaging.sendTextMessage(chatId, text, mentions);
  }

  async checkNumberExists(number: string): Promise<boolean> {
    return this.messaging.checkNumberExists(number);
  }

  async getNumberId(number: string): Promise<string | null> {
    return this.messaging.getNumberId(number);
  }

  async sendChatState(chatId: string, state: ChatState): Promise<void> {
    return this.messaging.sendChatState(chatId, state);
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.messaging.sendImageMessage(chatId, media);
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.messaging.sendVideoMessage(chatId, media);
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.messaging.sendAudioMessage(chatId, media);
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.messaging.sendDocumentMessage(chatId, media);
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.messaging.sendStickerMessage(chatId, media);
  }

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    return this.messaging.sendLocationMessage(chatId, location);
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    return this.messaging.sendContactMessage(chatId, contact);
  }

  async sendPollMessage(chatId: string, poll: PollInput): Promise<MessageResult> {
    return this.messaging.sendPollMessage(chatId, poll);
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    return this.messaging.replyToMessage(chatId, quotedMsgId, text);
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    return this.messaging.forwardMessage(fromChatId, toChatId, messageId);
  }

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    return this.messaging.reactToMessage(chatId, messageId, emoji);
  }

  async deleteMessage(chatId: string, messageId: string, forEveryone = true): Promise<void> {
    return this.messaging.deleteMessage(chatId, messageId, forEveryone);
  }

  async editMessage(chatId: string, messageId: string, body: string): Promise<MessageResult> {
    return this.messaging.editMessage(chatId, messageId, body);
  }

  // ----- Groups -----

  async getGroups(): Promise<Group[]> {
    return this.groups.getGroups();
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    return this.groups.getGroupInfo(groupId);
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    return this.groups.createGroup(name, participants);
  }

  async addParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.groups.addParticipants(groupId, participants);
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.groups.removeParticipants(groupId, participants);
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.groups.promoteParticipants(groupId, participants);
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.groups.demoteParticipants(groupId, participants);
  }

  async leaveGroup(groupId: string): Promise<void> {
    return this.groups.leaveGroup(groupId);
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    return this.groups.setGroupSubject(groupId, subject);
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    return this.groups.setGroupDescription(groupId, description);
  }

  async getGroupInviteCode(groupId: string): Promise<string> {
    return this.groups.getGroupInviteCode(groupId);
  }

  async revokeGroupInviteCode(groupId: string): Promise<string> {
    return this.groups.revokeGroupInviteCode(groupId);
  }

  async joinGroupViaInviteCode(inviteCode: string): Promise<string> {
    return this.groups.joinGroupViaInviteCode(inviteCode);
  }

  async setGroupMessagesAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    return this.groups.setGroupMessagesAdminsOnly(groupId, adminsOnly);
  }

  async setGroupInfoAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    return this.groups.setGroupInfoAdminsOnly(groupId, adminsOnly);
  }

  async setGroupEphemeral(groupId: string, durationSec: number): Promise<void> {
    return this.groups.setGroupEphemeral(groupId, durationSec);
  }

  async getProfilePicture(contactId: string): Promise<string | null> {
    return this.contacts.getProfilePicture(contactId);
  }

  async blockContact(contactId: string): Promise<void> {
    return this.contacts.blockContact(contactId);
  }

  async unblockContact(contactId: string): Promise<void> {
    return this.contacts.unblockContact(contactId);
  }

  // ----- Profile (own account) -----

  async setProfileName(name: string): Promise<void> {
    return this.contacts.setProfileName(name);
  }

  async setProfileStatus(status: string): Promise<void> {
    return this.contacts.setProfileStatus(status);
  }

  async setProfilePicture(media: MediaInput): Promise<void> {
    return this.contacts.setProfilePicture(media);
  }

  // ----- Contacts & chats -----

  async getContacts(): Promise<Contact[]> {
    return this.contacts.getContacts();
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    return this.contacts.getContactById(contactId);
  }

  async resolveContactPhone(contactId: string): Promise<string | null> {
    return this.contacts.resolveContactPhone(contactId);
  }

  async getChats(): Promise<ChatSummary[]> {
    return this.contacts.getChats();
  }

  async sendSeen(chatId: string): Promise<boolean> {
    return this.contacts.sendSeen(chatId);
  }

  async markUnread(chatId: string): Promise<boolean> {
    return this.contacts.markUnread(chatId);
  }

  async deleteChat(chatId: string): Promise<boolean> {
    return this.contacts.deleteChat(chatId);
  }

  // ----- Gated: not supported by this minimal slice (no store) -----
  /* eslint-disable @typescript-eslint/no-unused-vars */

  getMessageReactions(_chatId: string, _messageId: string): Promise<MessageReaction[]> {
    return this.unsupported('getMessageReactions');
  }
  getChatHistory(
    _chatId: string,
    _limit?: number,
    _includeMedia?: boolean,
    _mediaMaxBytes?: number,
    _signal?: AbortSignal,
  ): Promise<IncomingMessage[]> {
    return this.unsupported('getChatHistory');
  }
  getLabels(): Promise<Label[]> {
    return this.unsupported('getLabels');
  }
  getLabelById(_labelId: string): Promise<Label | null> {
    return this.unsupported('getLabelById');
  }
  getChatLabels(_chatId: string): Promise<Label[]> {
    return this.unsupported('getChatLabels');
  }
  // WhatsApp Business only — Baileys rejects these on personal accounts. The label must already
  // exist (use getLabels on an engine that lists them); addChatLabel/removeChatLabel associate it
  // with a chat, they do not create/edit the label definition.
  async addLabelToChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    await this.sock!.addChatLabel(chatId, labelId);
  }
  async removeLabelFromChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    await this.sock!.removeChatLabel(chatId, labelId);
  }
  getSubscribedChannels(): Promise<Channel[]> {
    return this.unsupported('getSubscribedChannels');
  }
  async getChannelById(channelId: string): Promise<Channel | null> {
    return this.channels.getChannelById(channelId);
  }

  async subscribeToChannel(inviteCode: string): Promise<Channel> {
    return this.channels.subscribeToChannel(inviteCode);
  }

  async unsubscribeFromChannel(channelId: string): Promise<void> {
    return this.channels.unsubscribeFromChannel(channelId);
  }

  // getChannelMessages is not wired: Baileys' newsletterFetchMessages returns the RAW query
  // BinaryNode with no library parser, so mapping it to ChannelMessage[] needs a verified
  // BinaryNode walk (or a live spike) that can't be validated without a WhatsApp session. Kept as a
  // documented adapter-gap in the engine capability matrix rather than shipped as an unverified walk.
  getChannelMessages(_channelId: string, _limit?: number): Promise<ChannelMessage[]> {
    return this.unsupported('getChannelMessages');
  }
  getContactStatuses(): Promise<Status[]> {
    return this.unsupported('getContactStatuses');
  }
  getContactStatus(_contactId: string): Promise<Status[]> {
    return this.unsupported('getContactStatus');
  }
  postTextStatus(text: string, options: StatusPostOptions): Promise<StatusResult> {
    return this.statusOps.postTextStatus(text, options);
  }
  postImageStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.statusOps.postImageStatus(media, options);
  }
  postVideoStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.statusOps.postVideoStatus(media, options);
  }
  async deleteStatus(statusId: string): Promise<void> {
    return this.statusOps.deleteStatus(statusId);
  }
  getCatalog(): Promise<Catalog | null> {
    return this.unsupported('getCatalog');
  }
  getProducts(_options?: ProductQueryOptions): Promise<PaginatedProducts> {
    return this.unsupported('getProducts');
  }
  getProduct(_productId: string): Promise<Product | null> {
    return this.unsupported('getProduct');
  }
  sendProduct(_chatId: string, _productId: string, _body?: string): Promise<MessageResult> {
    return this.unsupported('sendProduct');
  }
  sendCatalog(_chatId: string, _body?: string): Promise<MessageResult> {
    return this.unsupported('sendCatalog');
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */

  // ----- Events -----

  async rejectCall(callId: string): Promise<void> {
    return this.events.rejectCall(callId);
  }

  // ----- Helpers -----

  private normalizedSelfJid(): string {
    const phone = this.extractPhone(this.sock?.user?.id);
    return phone ? `${phone}@s.whatsapp.net` : '';
  }

  private unsupported(method: string): Promise<any> {
    return Promise.reject(new EngineNotSupportedError(method));
  }

  protected ensureReady(): void {
    if (this.status !== EngineStatus.READY || !this.sock) {
      throw new EngineNotReadyError();
    }
  }

  private setStatus(status: EngineStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    this.callbacks.onStateChanged?.(status);
  }

  /** `628999:12@s.whatsapp.net` / `628999@s.whatsapp.net` -> `628999`. */
  private extractPhone(id: string | undefined): string | null {
    if (!id) {
      return null;
    }
    return id.split(':')[0].split('@')[0] || null;
  }
}
