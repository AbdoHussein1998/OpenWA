import type { Client } from 'whatsapp-web.js';
import { WwebjsBridgeMonitor } from './wwebjs-bridge-monitor';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function clientWithAttach(fn: () => Promise<unknown>, patch?: boolean): Client {
  return { attachEventListeners: fn, eventsAttached: patch } as unknown as Client;
}

describe('WwebjsBridgeMonitor (1.34.8 without a local ready-sync patch)', () => {
  it('requires positive completion, not just an absent eventsAttached flag', async () => {
    const gate = deferred();
    const client = clientWithAttach(() => gate.promise);
    const monitor = new WwebjsBridgeMonitor();
    expect(monitor.instrument(client)).toBe(true);
    expect(monitor.getStatus(client)).toBe('attaching');
    const attaching = (client as unknown as { attachEventListeners: () => Promise<void> }).attachEventListeners();
    expect(monitor.getStatus(client)).toBe('attaching');
    gate.resolve();
    await attaching;
    expect(monitor.getStatus(client)).toBe('attached');
  });

  it('invalidates the old page and rejects an old asynchronous attach completion', async () => {
    const old = deferred();
    const latest = deferred();
    let calls = 0;
    const client = clientWithAttach(() => (++calls === 1 ? old.promise : latest.promise));
    const monitor = new WwebjsBridgeMonitor();
    monitor.instrument(client);
    const attach = (client as unknown as { attachEventListeners: () => Promise<void> }).attachEventListeners;
    const first = attach();
    monitor.invalidate(client);
    const second = attach();
    old.resolve();
    await first;
    expect(monitor.getStatus(client)).toBe('attaching');
    latest.resolve();
    await second;
    expect(monitor.getStatus(client)).toBe('attached');
    monitor.invalidate(client);
    expect(monitor.getStatus(client)).toBe('attaching');
  });

  it('does not manufacture a successful patch or swallow an upstream failure', async () => {
    const monitor = new WwebjsBridgeMonitor();
    const boom = new Error('attach failed');
    const client = clientWithAttach(async () => { throw boom; }, false);
    monitor.instrument(client);
    await expect(
      (client as unknown as { attachEventListeners: () => Promise<void> }).attachEventListeners(),
    ).rejects.toBe(boom);
    expect(monitor.getStatus(client)).toBe('attaching');
  });

  it('a local patch reporting false overrides completed observation', async () => {
    const monitor = new WwebjsBridgeMonitor();
    const client = clientWithAttach(async () => undefined, false);
    monitor.instrument(client);
    await (client as unknown as { attachEventListeners: () => Promise<void> }).attachEventListeners();
    expect(monitor.getStatus(client)).toBe('attaching');
    (client as Client & { eventsAttached?: boolean }).eventsAttached = true;
    expect(monitor.getStatus(client)).toBe('attached');
  });

  it('fails closed when private method is absent and isolates independent clients', async () => {
    const monitor = new WwebjsBridgeMonitor();
    const incompatible = {} as Client;
    expect(monitor.instrument(incompatible)).toBe(false);
    expect(monitor.getStatus(incompatible)).toBe('unverified');
    const a = clientWithAttach(async () => undefined);
    const b = clientWithAttach(async () => undefined);
    monitor.instrument(a);
    monitor.instrument(b);
    await (a as unknown as { attachEventListeners: () => Promise<void> }).attachEventListeners();
    expect(monitor.getStatus(a)).toBe('attached');
    expect(monitor.getStatus(b)).toBe('attaching');
  });
});
