



import {
  SessionScopes,
  SessionScopeType,
} from './session-scope';

describe('SessionScopes', () => {
  describe('all', () => {
    it('creates unrestricted ALL scope', () => {
      expect(
        SessionScopes.all(),
      ).toEqual({
        type: SessionScopeType.ALL,
      });
    });

    it('does not include session IDs or owner information', () => {
      const scope =
        SessionScopes.all();

      expect(scope).not.toHaveProperty(
        'sessionIds',
      );

      expect(scope).not.toHaveProperty(
        'ownerTeamLeaderId',
      );
    });
  });

  describe('none', () => {
    it('creates NONE scope', () => {
      expect(
        SessionScopes.none(),
      ).toEqual({
        type: SessionScopeType.NONE,
      });
    });

    it('does not include session IDs or owner information', () => {
      const scope =
        SessionScopes.none();

      expect(scope).not.toHaveProperty(
        'sessionIds',
      );

      expect(scope).not.toHaveProperty(
        'ownerTeamLeaderId',
      );
    });
  });

  describe('ids', () => {
    it('creates IDS scope for explicit session IDs', () => {
      expect(
        SessionScopes.ids([
          'session-a',
          'session-b',
        ]),
      ).toEqual({
        type:
          SessionScopeType.IDS,

        sessionIds: [
          'session-a',
          'session-b',
        ],
      });
    });

    it('returns NONE when the session ID list is empty', () => {
      expect(
        SessionScopes.ids([]),
      ).toEqual({
        type:
          SessionScopeType.NONE,
      });
    });

    it('removes duplicate session IDs', () => {
      expect(
        SessionScopes.ids([
          'session-a',
          'session-b',
          'session-a',
          'session-b',
          'session-c',
        ]),
      ).toEqual({
        type:
          SessionScopeType.IDS,

        sessionIds: [
          'session-a',
          'session-b',
          'session-c',
        ],
      });
    });

    it('preserves the insertion order of the first occurrence of each ID', () => {
      expect(
        SessionScopes.ids([
          'session-c',
          'session-a',
          'session-c',
          'session-b',
        ]),
      ).toEqual({
        type:
          SessionScopeType.IDS,

        sessionIds: [
          'session-c',
          'session-a',
          'session-b',
        ],
      });
    });

    it('copies the input array instead of retaining the caller array', () => {
      const input = [
        'session-a',
        'session-b',
      ];

      const scope =
        SessionScopes.ids(input);

      expect(scope.type).toBe(
        SessionScopeType.IDS,
      );

      if (
        scope.type !==
        SessionScopeType.IDS
      ) {
        throw new Error(
          'Expected IDS scope',
        );
      }

      expect(
        scope.sessionIds,
      ).not.toBe(input);

      input.push(
        'session-c',
      );

      expect(
        scope.sessionIds,
      ).toEqual([
        'session-a',
        'session-b',
      ]);
    });
  });

  describe('owner', () => {
    it('creates OWNER scope for one Team Leader', () => {
      expect(
        SessionScopes.owner(
          'team-leader-a',
        ),
      ).toEqual({
        type:
          SessionScopeType.OWNER,

        ownerTeamLeaderId:
          'team-leader-a',
      });
    });

    it('does not include explicit session IDs', () => {
      const scope =
        SessionScopes.owner(
          'team-leader-a',
        );

      expect(scope).not.toHaveProperty(
        'sessionIds',
      );
    });
  });

  describe('ownerAndIds', () => {
    it('creates OWNER_AND_IDS scope with owner and explicit session IDs', () => {
      expect(
        SessionScopes.ownerAndIds(
          'team-leader-a',
          [
            'session-a',
            'session-b',
          ],
        ),
      ).toEqual({
        type:
          SessionScopeType.OWNER_AND_IDS,

        ownerTeamLeaderId:
          'team-leader-a',

        sessionIds: [
          'session-a',
          'session-b',
        ],
      });
    });

    it('returns NONE when the explicit session ID intersection is empty', () => {
      expect(
        SessionScopes.ownerAndIds(
          'team-leader-a',
          [],
        ),
      ).toEqual({
        type:
          SessionScopeType.NONE,
      });
    });

    it('removes duplicate session IDs while preserving the owner', () => {
      expect(
        SessionScopes.ownerAndIds(
          'team-leader-a',
          [
            'session-a',
            'session-b',
            'session-a',
          ],
        ),
      ).toEqual({
        type:
          SessionScopeType.OWNER_AND_IDS,

        ownerTeamLeaderId:
          'team-leader-a',

        sessionIds: [
          'session-a',
          'session-b',
        ],
      });
    });

    it('copies the session ID input array', () => {
      const input = [
        'session-a',
        'session-b',
      ];

      const scope =
        SessionScopes.ownerAndIds(
          'team-leader-a',
          input,
        );

      expect(scope.type).toBe(
        SessionScopeType.OWNER_AND_IDS,
      );

      if (
        scope.type !==
        SessionScopeType.OWNER_AND_IDS
      ) {
        throw new Error(
          'Expected OWNER_AND_IDS scope',
        );
      }

      expect(
        scope.sessionIds,
      ).not.toBe(input);

      input.push(
        'session-c',
      );

      expect(
        scope.sessionIds,
      ).toEqual([
        'session-a',
        'session-b',
      ]);
    });

    it('preserves both independent restrictions required for intersection authorization', () => {
      const scope =
        SessionScopes.ownerAndIds(
          'team-leader-a',
          [
            'session-a',
            'session-b',
          ],
        );

      expect(scope.type).toBe(
        SessionScopeType.OWNER_AND_IDS,
      );

      if (
        scope.type !==
        SessionScopeType.OWNER_AND_IDS
      ) {
        throw new Error(
          'Expected OWNER_AND_IDS scope',
        );
      }

      expect(
        scope.ownerTeamLeaderId,
      ).toBe(
        'team-leader-a',
      );

      expect(
        scope.sessionIds,
      ).toEqual([
        'session-a',
        'session-b',
      ]);

      /**
       * IMPORTANT:
       *
       * This scope represents:
       *
       *   ownerTeamLeaderId = team-leader-a
       *
       * AND
       *
       *   id IN (session-a, session-b)
       *
       * It must never be interpreted as:
       *
       *   ownerTeamLeaderId = team-leader-a
       *
       * OR
       *
       *   id IN (session-a, session-b)
       *
       * The SQL/query translation itself is tested in
       * session.service.spec.ts.
       */
    });

    it('does not widen access when one of the explicit IDs could belong to another owner', () => {
      const scope =
        SessionScopes.ownerAndIds(
          'team-leader-a',
          [
            'owned-session',
            'foreign-session',
          ],
        );

      expect(scope).toEqual({
        type:
          SessionScopeType.OWNER_AND_IDS,

        ownerTeamLeaderId:
          'team-leader-a',

        sessionIds: [
          'owned-session',
          'foreign-session',
        ],
      });

      /**
       * The presence of foreign-session in sessionIds does NOT grant
       * access to it.
       *
       * Consumers must apply BOTH restrictions.
       */
    });
  });

  describe('scope type separation', () => {
    it('keeps ALL, NONE, IDS, OWNER, and OWNER_AND_IDS distinct', () => {
      expect(
        SessionScopes.all().type,
      ).toBe(
        SessionScopeType.ALL,
      );

      expect(
        SessionScopes.none().type,
      ).toBe(
        SessionScopeType.NONE,
      );

      expect(
        SessionScopes.ids([
          'session-a',
        ]).type,
      ).toBe(
        SessionScopeType.IDS,
      );

      expect(
        SessionScopes.owner(
          'team-leader-a',
        ).type,
      ).toBe(
        SessionScopeType.OWNER,
      );

      expect(
        SessionScopes.ownerAndIds(
          'team-leader-a',
          [
            'session-a',
          ],
        ).type,
      ).toBe(
        SessionScopeType.OWNER_AND_IDS,
      );
    });
  });
});



