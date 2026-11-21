/**
 * Tracks one Puppeteer-launched browser process for a single engine generation.
 * Monitoring is scoped by the Client object: late exit/error events from a retired
 * browser cannot disconnect a newer WhatsApp engine generation.
 * Termination itself is delegated to BraveProfileManager, which verifies OS ownership.
 */
export interface ObservedBrowserProcess {
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: string | null;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'exit' | 'error', listener: (...args: unknown[]) => void): unknown;
}

export class BraveProcessSupervisor {
  private active?: {
    owner: object;
    process: ObservedBrowserProcess;
    exitListener: (code: number | null, signal: string | null) => void;
    errorListener: (error: Error) => void;
  };

  observe(owner: object, child: ObservedBrowserProcess | null | undefined,
          onUnexpectedExit: (reason: string, pid: number) => void,
          onProcessError?: (error: Error, pid: number) => void): number | null {
    this.detach();
    if (!child || !Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 0) return null;
    const pid = child.pid!;
    const exitListener = (code: number | null, signal: string | null): void => {
      if (this.active?.owner === owner && this.active.process === child) {
        onUnexpectedExit(`Brave browser PID ${pid} exited (code=${code}, signal=${signal})`, pid);
      }
    };
    const errorListener = (error: Error): void => {
      if (this.active?.owner === owner && this.active.process === child) {
        // A ChildProcess 'error' can mean a failed signal, not a dead browser.
        // Report it but let the exit event / Puppeteer disconnect decide liveness.
        onProcessError?.(error, pid);
      }
    };
    this.active = { owner, process: child, exitListener, errorListener };
    child.on('exit', exitListener);
    child.on('error', errorListener);
    // The process may have died between Client.initialize() and listener registration.
    if (child.exitCode !== null && child.exitCode !== undefined || child.signalCode) {
      exitListener(child.exitCode ?? null, child.signalCode ?? null);
    }
    return pid;
  }

  getPid(owner: object): number | null {
    return this.active?.owner === owner ? this.active.process.pid ?? null : null;
  }

  detach(owner?: object): void {
    const tracked = this.active;
    if (!tracked || owner && tracked.owner !== owner) return;
    this.active = undefined;
    tracked.process.removeListener('exit', tracked.exitListener as (...args: unknown[]) => void);
    tracked.process.removeListener('error', tracked.errorListener as (...args: unknown[]) => void);
  }
}
