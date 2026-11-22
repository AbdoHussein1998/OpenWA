/**
 * Observes a single Puppeteer-launched child process for one WhatsApp client
 * generation. This class does NOT own, stop, or kill the process: that belongs
 * to BrowserProfileManager after verification of the lease and OS identity.
 *
 * A stale child cannot call the callbacks for a newer observed generation.
 */
export interface ObservedBrowserProcess {
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: string | null;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'exit' | 'error', listener: (...args: unknown[]) => void): unknown;
}

export class BrowserProcessSupervisor {
  private active?: {
    owner: object;
    process: ObservedBrowserProcess;
    exitListener: (code: number | null, signal: string | null) => void;
    errorListener: (error: Error) => void;
  };

  /**
   * @param label Label for the human-readable exit reason only (not ownership).
   * The legacy BraveProcessSupervisor retains its historic exit reason wording.
   */
  constructor(private readonly label = 'Browser') {}

  observe(
    owner: object,
    child: ObservedBrowserProcess | null | undefined,
    onUnexpectedExit: (reason: string, pid: number) => void,
    onProcessError?: (error: Error, pid: number) => void,
  ): number | null {
    // An old generation must be detached even if the replacement child is invalid.
    this.detach();
    if (!child || !Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 0) return null;
    const pid = child.pid!;
    const exitListener = (code: number | null, signal: string | null): void => {
      if (this.active?.owner === owner && this.active.process === child) {
        onUnexpectedExit(`${this.label} PID ${pid} exited (code=${code}, signal=${signal})`, pid);
      }
    };
    const errorListener = (error: Error): void => {
      if (this.active?.owner === owner && this.active.process === child) {
        // An OS ChildProcess 'error' can be an unsuccessful kill signal rather
        // than evidence of death. Never infer that the profile is free here.
        onProcessError?.(error, pid);
      }
    };
    this.active = { owner, process: child, exitListener, errorListener };
    child.on('exit', exitListener);
    child.on('error', errorListener);
    // The child may have exited before client initialization returned.
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
