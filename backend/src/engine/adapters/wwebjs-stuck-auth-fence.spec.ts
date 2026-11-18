import { EventEmitter } from 'events';
import type { Client } from 'whatsapp-web.js';
import { EngineStatus, type EngineEventCallbacks } from '../interfaces/whatsapp-engine.interface';
import { WwebjsStuckAuth, type WwebjsStuckAuthHost } from './wwebjs-stuck-auth';
import type { BraveProfileManager } from '../brave/brave-profile.manager';

describe('Stuck-auth profile deletion / session-name teardown fence', () => {
  it('registers the whole reset synchronously, before waiting for Chromium termination', async () => {
    let finishDestroy!: () => void;
    const pendingDestroy = new Promise<void>(resolve => { finishDestroy = resolve; });
    const client = Object.assign(new EventEmitter(), {
      destroy: jest.fn(() => pendingDestroy),
    }) as unknown as Client;
    let live: Client | null = client;
    let tracked: Promise<void> | undefined;
    const cleared = jest.fn().mockResolvedValue(undefined);
    const disconnected = jest.fn();
    const statuses: EngineStatus[] = [];
    const callbacks: EngineEventCallbacks = {
      claimStuckAuthRecovery: () => true,
      onCredentialTeardownStarted: promise => { tracked = promise; },
      onDisconnected: disconnected,
    };
    const manager = {
      getProfilePath: () => '/profiles/demo',
      killOrphanedBraveProcesses: jest.fn().mockResolvedValue(undefined),
      deleteProfile: cleared,
    } as unknown as BraveProfileManager;
    const host = {
      logger: { warn: jest.fn(), error: jest.fn() },
      config: { sessionId: 'demo', sessionDataPath: '/sessions', braveProfileManager: manager },
      getClient: () => live,
      setClient: (value: Client | null) => { live = value; },
      setStatus: (value: EngineStatus) => { statuses.push(value); },
      getCallbacks: () => callbacks,
    } as unknown as WwebjsStuckAuthHost;

    const recovery = new WwebjsStuckAuth(host);
    const operation = recovery.recoverFromStuckAuth();
    expect(live).toBeNull();
    expect(tracked).toBeDefined();
    expect(cleared).not.toHaveBeenCalled();
    expect(disconnected).not.toHaveBeenCalled();

    finishDestroy();
    await operation;
    await tracked;
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(statuses).toContain(EngineStatus.DISCONNECTED);
    expect(disconnected).toHaveBeenCalledTimes(1);
  });
});
