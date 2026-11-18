import { ForbiddenException } from '@nestjs/common';
import { allowedSessionIdsForQuery } from './session-scope-query';
import { SessionScopes } from './session-scope';

describe('scope-to-query translation: deny by default, never widen', () => {
  it('applies the optional query filter to ALL', () => {
    expect(allowedSessionIdsForQuery(SessionScopes.all())).toBeNull();
    expect(allowedSessionIdsForQuery(SessionScopes.all(), 's1')).toEqual(['s1']);
  });

  it('keeps NONE denied even with an explicit session ID', () => {
    expect(allowedSessionIdsForQuery(SessionScopes.none(), 's1')).toEqual([]);
  });

  it('intersects requested IDs with the effective allowlist', () => {
    const scope = SessionScopes.ids(['s1', 's2']);
    expect(allowedSessionIdsForQuery(scope, 's2')).toEqual(['s2']);
    expect(allowedSessionIdsForQuery(scope, 'foreign')).toEqual([]);
  });

  it('denies OWNER rather than treating its undefined IDs as global access', () => {
    expect(() => allowedSessionIdsForQuery(SessionScopes.owner('tl-1')))
      .toThrow(ForbiddenException);
  });

  it('denies OWNER_AND_IDS until ownership has been verified', () => {
    expect(() => allowedSessionIdsForQuery(SessionScopes.ownerAndIds('tl-1', ['foreign'])))
      .toThrow(ForbiddenException);
  });

  it('rejects omitted scope instead of defaulting to ALL', () => {
    expect(() => allowedSessionIdsForQuery(undefined as never)).toThrow(ForbiddenException);
  });
});
