import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { hostname } from 'node:os';
import { In, IsNull, LessThan, Repository } from 'typeorm';
import { Session } from './entities/session.entity';
import { createLogger } from '../../common/services/logger.service';
import { DateTransformer } from '../../common/transformers/date.transformer';

/**
 * Who currently hosts each session's engine.
 *
 * A session's engine runs in exactly one process. Nothing recorded which, so a booting process had
 * to assume every active-looking session was its own leftover and reset it — correct while there is
 * only one process, and destructive the moment a second one boots beside a live peer.
 *
 * The claim is a lease rather than a lock. A process that dies without releasing would otherwise
 * strand its sessions forever, so a claim simply stops being honoured once it goes unrenewed; a
 * running owner keeps extending it. That makes recovery automatic and bounded by the TTL instead of
 * conditional on a clean shutdown.
 *
 * NOTE: this establishes ownership. It does not yet route a request to the owning node, nor fence
 * every lifecycle path — see the horizontal-scaling documentation for what remains.
 */
@Injectable()
export class SessionOwnershipService {
  private readonly logger = createLogger('SessionOwnershipService');
  private heartbeat?: ReturnType<typeof setInterval>;
  /** Sessions this process believes it owns, so the heartbeat knows what to renew. */
  private readonly owned = new Set<string>();

  constructor(
    @InjectRepository(Session, 'data')
    private readonly sessions: Repository<Session>,
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  /**
   * This process's identity, stable across restarts.
   *
   * Deliberately not tied to the pid: a restarted process must recognise its own previous rows in
   * order to reset them, and a pid never matches after a restart. The hostname is stable for the
   * lifetime of a container or a host; where that is not the right boundary, `NODE_ID` overrides it.
   */
  get nodeId(): string {
    return this.configService?.get<string>('session.nodeId') || process.env.NODE_ID || hostname();
  }

  private get leaseTtlMs(): number {
    return this.configService?.get<number>('session.leaseTtlMs') ?? 60_000;
  }

  private get heartbeatMs(): number {
    return this.configService?.get<number>('session.leaseHeartbeatMs') ?? 20_000;
  }

  /**
   * A session is takeable when nobody holds it, when this process already holds it, or when the
   * holder's lease has lapsed. Expressed as a `where` fragment so the same rule drives the boot
   * reset, the auto-start scan and the claim itself — three places that must not disagree.
   */
  claimableWhere(now = new Date()): Array<Record<string, unknown>> {
    return [{ nodeId: IsNull() }, { nodeId: this.nodeId }, { leaseExpiresAt: LessThan(now) }];
  }

  /** Session ids this process may take over, out of the ones given. */
  async claimable(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.sessions.find({
      where: this.claimableWhere().map(clause => ({ ...clause, id: In(ids) })),
      select: { id: true },
    });
    return rows.map(row => row.id);
  }

  /**
   * Take ownership, returning false when another live process holds it.
   *
   * The update is conditional on the same predicate the read used, so two processes racing on the
   * same free session cannot both succeed: the second one's UPDATE matches no row, because the
   * first has already written its own `nodeId` and a future expiry. Deciding on the read alone
   * would let both pass.
   */
  async claim(sessionId: string): Promise<boolean> {
    const now = new Date();
    const result = await this.sessions
      .createQueryBuilder()
      .update(Session)
      .set({ nodeId: this.nodeId, claimedAt: now, leaseExpiresAt: new Date(now.getTime() + this.leaseTtlMs) })
      .where('id = :id', { id: sessionId })
      // `now` goes through the column's own transformer. Raw SQL bypasses it, and the stored form
      // is not a Date on every dialect — SQLite keeps an ISO string — so an untransformed parameter
      // compares against the wrong representation and the clause silently never matches. That would
      // not fail loudly: expired claims would simply never be taken over, stranding every session a
      // crashed process was holding.
      .andWhere('("nodeId" IS NULL OR "nodeId" = :me OR "leaseExpiresAt" < :now)', {
        me: this.nodeId,
        now: DateTransformer.to(now),
      })
      .execute();

    const claimed = (result.affected ?? 0) > 0;
    if (claimed) this.owned.add(sessionId);
    else this.logger.warn('Session is held by another node', { sessionId, nodeId: this.nodeId });
    return claimed;
  }

  /** Give a session up, so a peer can take it without waiting for the lease to lapse. */
  async release(sessionId: string): Promise<void> {
    this.owned.delete(sessionId);
    await this.sessions
      .createQueryBuilder()
      .update(Session)
      .set({ nodeId: null, claimedAt: null, leaseExpiresAt: null })
      .where('id = :id AND "nodeId" = :me', { id: sessionId, me: this.nodeId })
      .execute();
  }

  /** Release everything this process holds, on the way down. */
  async releaseAll(): Promise<void> {
    const ids = [...this.owned];
    this.owned.clear();
    if (ids.length === 0) return;
    await this.sessions
      .createQueryBuilder()
      .update(Session)
      .set({ nodeId: null, claimedAt: null, leaseExpiresAt: null })
      .where({ id: In(ids), nodeId: this.nodeId })
      .execute();
    this.logger.log(`Released ${ids.length} session claim(s) on shutdown`, { nodeId: this.nodeId });
  }

  /** Begin renewing this process's leases. Idempotent. */
  startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      void this.renew();
    }, this.heartbeatMs);
    // Never hold the process open: a lease that stops being renewed is exactly what shutdown means.
    this.heartbeat.unref?.();
  }

  stopHeartbeat(): void {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  /** Push every held lease out by another TTL. */
  async renew(): Promise<void> {
    const ids = [...this.owned];
    if (ids.length === 0) return;
    try {
      await this.sessions
        .createQueryBuilder()
        .update(Session)
        .set({ leaseExpiresAt: new Date(Date.now() + this.leaseTtlMs) })
        .where({ id: In(ids), nodeId: this.nodeId })
        .execute();
    } catch (error) {
      // A failed renewal is survivable — the next tick tries again, and the TTL is long enough to
      // absorb a transient database blip. Throwing here would take down the interval instead.
      this.logger.warn('Failed to renew session leases', {
        nodeId: this.nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** For the boot reset, which must run before anything is claimed. */
  ownedByOtherLiveNode(session: Pick<Session, 'nodeId' | 'leaseExpiresAt'>, now = new Date()): boolean {
    if (!session.nodeId || session.nodeId === this.nodeId) return false;
    return session.leaseExpiresAt != null && session.leaseExpiresAt > now;
  }

  /** Test seam: what this process currently believes it holds. */
  ownedIds(): string[] {
    return [...this.owned];
  }
}
