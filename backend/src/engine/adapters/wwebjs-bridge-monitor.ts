import type { Client } from 'whatsapp-web.js';

/** Positive, per-client proof that whatsapp-web.js's page→Node event attachment completed. */
export type WwebjsBridgeStatus = 'attached' | 'attaching' | 'unverified';
type AttachEventListeners = (...args: unknown[]) => Promise<unknown>;
type InstrumentableClient = { attachEventListeners?: AttachEventListeners; eventsAttached?: boolean };
interface BridgeRecord { epoch: number; attached: boolean; instrumented: boolean; }

export class WwebjsBridgeMonitor {
  private readonly records = new WeakMap<Client, BridgeRecord>();

  instrument(client: Client): boolean {
    const existing = this.records.get(client);
    if (existing) return existing.instrumented;
    const record: BridgeRecord = { epoch: 0, attached: false, instrumented: false };
    this.records.set(client, record);
    const target = client as unknown as InstrumentableClient;
    const original = target.attachEventListeners;
    if (typeof original !== 'function') return false;
    try {
      // Observe the existing 1.34.8 internal method. Never skip, replay or change its return value.
      target.attachEventListeners = async (...args: unknown[]): Promise<unknown> => {
        const epoch = ++record.epoch;
        record.attached = false;
        try {
          const result = await original.apply(client, args);
          if (record.epoch === epoch) record.attached = true;
          return result;
        } catch (error) {
          if (record.epoch === epoch) record.attached = false;
          throw error;
        }
      };
      record.instrumented = true;
      return true;
    } catch {
      return false; // Incompatible/frozen upstream Client: fail closed.
    }
  }

  invalidate(client: Client): void {
    const record = this.records.get(client);
    if (!record) return;
    ++record.epoch;
    record.attached = false;
  }

  getStatus(client: Client | null): WwebjsBridgeStatus {
    if (!client) return 'unverified';
    const record = this.records.get(client);
    const patched = (client as unknown as InstrumentableClient).eventsAttached;
    if (record) {
      if (!record.instrumented) return 'unverified';
      return record.attached && patched !== false ? 'attached' : 'attaching';
    }
    // Only externally injected clients (e.g. test fixtures) lack a record: all lifecycle-created
    // clients are instrumented before initialize, so absent patched flag never authorizes READY.
    return patched === true ? 'attached' : patched === false ? 'attaching' : 'unverified';
  }
}
