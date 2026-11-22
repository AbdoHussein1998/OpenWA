/**
 * Compatibility entrypoint for Phase 3. Existing adapters still import this
 * module until the later lifecycle integration phase.
 */
import { BrowserProcessSupervisor } from '../browser/browser-process-supervisor';

export type { ObservedBrowserProcess } from '../browser/browser-process-supervisor';

/** Preserves the old exit-reason text and the original public API. */
export class BraveProcessSupervisor extends BrowserProcessSupervisor {
  constructor() {
    super('Brave browser');
  }
}
