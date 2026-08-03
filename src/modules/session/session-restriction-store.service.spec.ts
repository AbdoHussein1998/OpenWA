import { SessionRestrictionStore } from './session-restriction-store.service';
import { getRestrictedSessionCount } from '../../common/metrics/session-restriction-metrics';
import { Session, SessionStatus } from './entities/session.entity';
import type { AccountRestriction } from '../../engine/interfaces/whatsapp-engine.interface';

const timelock = (over: Partial<AccountRestriction> = {}): AccountRestriction => ({
  kind: 'reachout_timelock',
  code: 'BIZ_QUALITY',
  ...over,
});

const tosBlock = (): AccountRestriction => ({ kind: 'tos_block', code: 'TOS_BLOCK' });

const sessionRow = (id: string, status = SessionStatus.READY): Session => ({ id, status }) as Session;

describe('SessionRestrictionStore', () => {
  let store: SessionRestrictionStore;

  beforeEach(() => {
    store = new SessionRestrictionStore();
  });

  describe('reporting a change', () => {
    // The dedupe is the whole reason set() returns a boolean: whatsapp-web.js re-reports the same
    // block on every reconnect attempt and the Baileys probe re-reads the same timelock on every
    // connect, so an un-deduped caller would announce one unchanged fact on a loop.
    it('is news the first time and not afterwards', () => {
      expect(store.set('s1', timelock())).toBe(true);
      expect(store.set('s1', timelock())).toBe(false);
      expect(store.set('s1', timelock())).toBe(false);
    });

    it('is news again when the cause changes', () => {
      store.set('s1', timelock({ code: 'BIZ_QUALITY' }));

      expect(store.set('s1', timelock({ code: 'WEB_COMPANION_ONLY' }))).toBe(true);
    });

    it('is news when the kind changes even though the session already had a restriction', () => {
      store.set('s1', timelock());

      expect(store.set('s1', tosBlock())).toBe(true);
    });

    // Sessions must not dedupe against each other — the map is keyed per session, and an account
    // restricted for the same reason as another is still separate news.
    it('tracks sessions independently', () => {
      expect(store.set('s1', timelock())).toBe(true);
      expect(store.set('s2', timelock())).toBe(true);
      expect(store.get('s1')).toEqual(timelock());
      expect(store.get('s2')).toEqual(timelock());
    });

    // Announcing a re-report would be noise, but serving a stale expiry from the API would be wrong,
    // so the stored entry refreshes even when the caller is told nothing changed.
    it('refreshes the stored expiry without announcing it', () => {
      store.set('s1', timelock({ expiresAt: 1000 }));

      expect(store.set('s1', timelock({ expiresAt: 9999 }))).toBe(false);
      expect(store.get('s1')?.expiresAt).toBe(9999);
    });
  });

  describe('clearing', () => {
    it('returns what it removed so the caller can report the cause that ended', () => {
      store.set('s1', timelock());

      expect(store.clear('s1')).toEqual(timelock());
      expect(store.get('s1')).toBeUndefined();
    });

    it('returns nothing when there was no restriction, so no lift is announced', () => {
      expect(store.clear('s1')).toBeUndefined();
    });

    // The load-bearing distinction between the two engines' restrictions. A connection-level block is
    // exactly what prevents a session from reaching READY, so being READY disproves it.
    it('READY disproves a connection-level block', () => {
      store.set('s1', tosBlock());

      expect(store.clearIfDisprovedByReady('s1')).toEqual(tosBlock());
      expect(store.get('s1')).toBeUndefined();
    });

    // …but a timelock leaves the account fully connected, so READY says nothing about it. Clearing it
    // here would silently drop a restriction that is still in force.
    it('READY does not disprove a reachout timelock', () => {
      store.set('s1', timelock());

      expect(store.clearIfDisprovedByReady('s1')).toBeUndefined();
      expect(store.get('s1')).toEqual(timelock());
    });

    it('READY on an unrestricted session is a no-op', () => {
      expect(store.clearIfDisprovedByReady('s1')).toBeUndefined();
    });
  });

  describe('the gauge', () => {
    // The metric is mirrored out of the store rather than read from it, so every mutation path has
    // to republish or the gauge drifts from reality.
    it('counts restricted sessions as they are added and removed', () => {
      store.set('s1', timelock());
      store.set('s2', tosBlock());
      expect(getRestrictedSessionCount()).toBe(2);

      store.clear('s1');
      expect(getRestrictedSessionCount()).toBe(1);

      store.clearIfDisprovedByReady('s2');
      expect(getRestrictedSessionCount()).toBe(0);
    });

    it('does not double-count a session whose restriction is re-reported', () => {
      store.set('s1', timelock());
      store.set('s1', timelock());
      store.set('s1', timelock({ code: 'WEB_COMPANION_ONLY' }));

      expect(getRestrictedSessionCount()).toBe(1);
    });

    // The count is per-deployment, not per-session: clearing one session republishes the whole map's
    // size, so a delete of an unrestricted session must not disturb what other sessions contribute.
    it('leaves the count alone when clearing a session that was not restricted', () => {
      store.set('s1', timelock());

      store.clear('s2');

      expect(getRestrictedSessionCount()).toBe(1);
    });
  });

  describe('the read projection', () => {
    it('attaches the restriction in force', () => {
      store.set('s1', timelock({ expiresAt: 1234 }));

      expect(store.attachTo(sessionRow('s1')).restriction).toEqual(timelock({ expiresAt: 1234 }));
    });

    it('attaches null when there is none, so the field is always present', () => {
      expect(store.attachTo(sessionRow('s1')).restriction).toBeNull();
    });

    // Unlike lastError, this is NOT conditioned on the session's status: a reachout timelock applies
    // to a perfectly READY session, and hiding it behind a status would make it invisible exactly
    // when it matters.
    it.each([SessionStatus.READY, SessionStatus.DISCONNECTED, SessionStatus.FAILED, SessionStatus.CREATED])(
      'surfaces the restriction while the status is %s',
      status => {
        store.set('s1', timelock());

        expect(store.attachTo(sessionRow('s1', status)).restriction).toEqual(timelock());
      },
    );
  });
});
