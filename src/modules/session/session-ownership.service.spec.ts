import { DataSource, Repository } from 'typeorm';
import { SessionOwnershipService } from './session-ownership.service';
import { Session } from './entities/session.entity';
import { SessionStatus } from './entities/session.entity';

/**
 * Run against a real in-memory database rather than a mocked repository, because the part that has
 * to be right is the SQL: the claim is a conditional UPDATE, and whether two processes can both
 * win a race depends on the WHERE clause actually filtering. A mock would agree with whatever the
 * query builder was asked to do and prove nothing about the outcome.
 */
describe('SessionOwnershipService', () => {
  let dataSource: DataSource;
  let sessions: Repository<Session>;

  const nodeConfig = (nodeId: string, leaseTtlMs = 60_000) =>
    ({
      get: (key: string) => ({ 'session.nodeId': nodeId, 'session.leaseTtlMs': leaseTtlMs })[key as string],
    }) as never;

  const service = (nodeId: string, leaseTtlMs?: number): SessionOwnershipService =>
    new SessionOwnershipService(sessions, nodeConfig(nodeId, leaseTtlMs));

  const seed = async (overrides: Partial<Session> = {}): Promise<Session> =>
    sessions.save(
      sessions.create({
        name: `s-${Math.floor(performance.now() * 1000)}-${overrides.nodeId ?? 'free'}`,
        status: SessionStatus.READY,
        config: {},
        ...overrides,
      }),
    );

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session],
      synchronize: true,
    });
    await dataSource.initialize();
    sessions = dataSource.getRepository(Session);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  afterEach(async () => {
    await sessions.clear();
  });

  describe('claiming', () => {
    it('claims a session nobody holds, recording this node and a future expiry', async () => {
      const session = await seed();

      await expect(service('node-a').claim(session.id)).resolves.toBe(true);

      const stored = await sessions.findOneByOrFail({ id: session.id });
      expect(stored.nodeId).toBe('node-a');
      expect(stored.claimedAt).toBeInstanceOf(Date);
      expect(stored.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    });

    // The whole point: the second process must lose, and must lose in the database rather than by
    // having read a stale row a moment earlier.
    it('refuses a session another node holds on a live lease', async () => {
      const session = await seed();
      await service('node-a').claim(session.id);

      await expect(service('node-b').claim(session.id)).resolves.toBe(false);
      expect((await sessions.findOneByOrFail({ id: session.id })).nodeId).toBe('node-a');
    });

    it('lets a node re-claim what it already holds, so a restart is not blocked by itself', async () => {
      const session = await seed();
      const node = service('node-a');
      await node.claim(session.id);

      await expect(node.claim(session.id)).resolves.toBe(true);
    });

    // A process that dies without releasing must not strand its sessions forever.
    it('takes over once the holder’s lease has lapsed', async () => {
      const session = await seed({
        nodeId: 'node-a',
        claimedAt: new Date(Date.now() - 120_000),
        leaseExpiresAt: new Date(Date.now() - 60_000),
      });

      await expect(service('node-b').claim(session.id)).resolves.toBe(true);
      expect((await sessions.findOneByOrFail({ id: session.id })).nodeId).toBe('node-b');
    });

    it('only one of two nodes racing for the same free session wins', async () => {
      const session = await seed();

      const results = await Promise.all([service('node-a').claim(session.id), service('node-b').claim(session.id)]);

      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });

  describe('releasing', () => {
    it('frees the session so a peer can take it without waiting for the lease', async () => {
      const session = await seed();
      const nodeA = service('node-a');
      await nodeA.claim(session.id);

      await nodeA.release(session.id);

      const stored = await sessions.findOneByOrFail({ id: session.id });
      expect(stored.nodeId).toBeNull();
      expect(stored.leaseExpiresAt).toBeNull();
      await expect(service('node-b').claim(session.id)).resolves.toBe(true);
    });

    // Releasing must be scoped to what this node holds, or a shutting-down process would hand away
    // a peer's live session.
    it('does not release a session another node holds', async () => {
      const session = await seed();
      await service('node-a').claim(session.id);

      await service('node-b').release(session.id);

      expect((await sessions.findOneByOrFail({ id: session.id })).nodeId).toBe('node-a');
    });

    it('releases everything held, on the way down', async () => {
      const [one, two] = [await seed(), await seed()];
      const nodeA = service('node-a');
      await nodeA.claim(one.id);
      await nodeA.claim(two.id);

      await nodeA.releaseAll();

      expect(nodeA.ownedIds()).toEqual([]);
      expect((await sessions.findOneByOrFail({ id: one.id })).nodeId).toBeNull();
      expect((await sessions.findOneByOrFail({ id: two.id })).nodeId).toBeNull();
    });
  });

  describe('renewing', () => {
    it('pushes the expiry out, so a busy node does not lose what it is running', async () => {
      const session = await seed();
      const nodeA = service('node-a', 5_000);
      await nodeA.claim(session.id);
      const first = (await sessions.findOneByOrFail({ id: session.id })).leaseExpiresAt!;

      await new Promise(resolve => setTimeout(resolve, 25));
      await nodeA.renew();

      const renewed = (await sessions.findOneByOrFail({ id: session.id })).leaseExpiresAt!;
      expect(renewed.getTime()).toBeGreaterThan(first.getTime());
    });

    /**
     * A node that lost a session must stop extending it. Renewal only writes `leaseExpiresAt`, so
     * the evidence is that value staying put — a stale node refreshing a peer's lease would keep
     * the peer's claim alive on the strength of a process that no longer owns anything.
     */
    it('never renews a session it no longer holds', async () => {
      const session = await seed();
      const nodeA = service('node-a');
      await nodeA.claim(session.id);
      // A peer took over after the lease lapsed; this node still has it in its own set.
      // Deliberately far from the TTL a renewal would write, so an unscoped renew is visible.
      // Matching the TTL would let both land on the same millisecond and read as "unchanged".
      const peerExpiry = new Date(Date.now() + 600_000);
      await sessions.update({ id: session.id }, { nodeId: 'node-b', leaseExpiresAt: peerExpiry });

      await nodeA.renew();

      const stored = await sessions.findOneByOrFail({ id: session.id });
      expect(stored.nodeId).toBe('node-b');
      expect(stored.leaseExpiresAt!.getTime()).toBe(peerExpiry.getTime());
    });
  });

  describe('what a booting process may reset', () => {
    const now = new Date();

    it('leaves alone a session another node holds on a live lease', () => {
      expect(
        service('node-b').ownedByOtherLiveNode(
          { nodeId: 'node-a', leaseExpiresAt: new Date(now.getTime() + 60_000) },
          now,
        ),
      ).toBe(true);
    });

    it('reclaims its own rows, which really are dead after a restart', () => {
      expect(
        service('node-a').ownedByOtherLiveNode(
          { nodeId: 'node-a', leaseExpiresAt: new Date(now.getTime() + 60_000) },
          now,
        ),
      ).toBe(false);
    });

    it('reclaims an unowned row and one whose lease has lapsed', () => {
      const node = service('node-b');
      expect(node.ownedByOtherLiveNode({ nodeId: null, leaseExpiresAt: null }, now)).toBe(false);
      expect(node.ownedByOtherLiveNode({ nodeId: 'node-a', leaseExpiresAt: new Date(now.getTime() - 1) }, now)).toBe(
        false,
      );
    });
  });

  /**
   * Drives an operator-facing warning during a data import: this process can only stop its own
   * engines, so a session running elsewhere has to be named rather than quietly counted as handled.
   */
  describe('sessions held elsewhere', () => {
    it('names sessions another node holds on a live lease', async () => {
      const mine = await seed();
      const peers = await seed();
      await service('node-a').claim(mine.id);
      await service('node-b').claim(peers.id);

      await expect(service('node-a').heldByOtherNodes()).resolves.toEqual([peers.id]);
    });

    it('ignores unclaimed sessions and lapsed claims, which nobody is running', async () => {
      await seed();
      await seed({ nodeId: 'node-b', leaseExpiresAt: new Date(Date.now() - 1_000) });

      await expect(service('node-a').heldByOtherNodes()).resolves.toEqual([]);
    });
  });

  describe('node identity', () => {
    it('falls back to the hostname when nothing is configured, and never to the pid', () => {
      const bare = new SessionOwnershipService(sessions);
      expect(bare.nodeId).toBeTruthy();
      // A pid-derived id would never match after a restart, so a process could not recognise — and
      // therefore could not reset — its own leftover rows.
      expect(bare.nodeId).not.toContain(String(process.pid));
    });
  });
});
