import {
  NotImplementedException,
} from '@nestjs/common';
import type {
  DataSource,
  Repository,
} from 'typeorm';

import { SearchService } from './search.service';
import { SearchProviderRegistry } from './search-provider.registry';
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_LIMIT_MAX,
  SEARCH_OFFSET_MAX,
} from './search.constants';
import type {
  SearchProvider,
  SearchResults,
} from './search.types';

import {
  SessionScopes,
  type SessionScope,
} from '../access-control/session-scope';
import { Session } from '../session/entities/session.entity';
import { SessionTombstone } from '../session/entities/session-tombstone.entity';

function mkProvider(
  id: string,
  search: SearchProvider['search'],
): SearchProvider {
  return {
    id,
    label: id,
    health: jest.fn().mockResolvedValue({
      ok: true,
    }),
    search,
  };
}

const emptyResults = {
  hits: [],
  total: 0,
  tookMs: 1,
  provider: 'builtin-fts',
} satisfies SearchResults;

interface SearchRepoMocks {
  sessionFind: jest.Mock;
  tombstoneFind: jest.Mock;
}

function makeDataSource(
  overrides: Partial<SearchRepoMocks> = {},
): {
  dataSource: DataSource;
  mocks: SearchRepoMocks;
} {
  const mocks: SearchRepoMocks = {
    sessionFind: overrides.sessionFind ?? jest.fn().mockResolvedValue([]),
    tombstoneFind: overrides.tombstoneFind ?? jest.fn().mockResolvedValue([]),
  };

  const sessionRepository = {
    find: mocks.sessionFind,
  } as unknown as Repository<Session>;

  const tombstoneRepository = {
    find: mocks.tombstoneFind,
  } as unknown as Repository<SessionTombstone>;

  return {
    dataSource: {
      getRepository: jest.fn((target: unknown) => {
        if (target === Session) return sessionRepository;
        if (target === SessionTombstone) return tombstoneRepository;
        throw new Error('unexpected repository target');
      }),
    } as unknown as DataSource,
    mocks,
  };
}

function makeService(
  registry: SearchProviderRegistry,
  dataSource?: DataSource,
): SearchService {
  return new SearchService(
    registry,
    dataSource ?? makeDataSource().dataSource,
  );
}

const ALL_SCOPE: SessionScope =
  SessionScopes.all();

describe('SearchService', () => {
  it('throws 501 (NotImplementedException) when no provider is active', async () => {
    const svc = makeService(
      new SearchProviderRegistry(),
    );

    await expect(
      svc.search(
        {
          q: 'x',
        },
        ALL_SCOPE,
      ),
    ).rejects.toBeInstanceOf(
      NotImplementedException,
    );
  });

  it('delegates to the active provider with sessionIds resolved from SessionScope', async () => {
    const reg =
      new SearchProviderRegistry();

    const search = jest
      .fn()
      .mockResolvedValue(
        emptyResults,
      );

    reg.register(
      mkProvider(
        'builtin-fts',
        search,
      ),
    );

    const svc =
      makeService(reg);

    await svc.search(
      {
        q: 'x',
      },
      SessionScopes.ids([
        's1',
        's2',
      ]),
    );

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'x',
        sessionIds: [
          's1',
          's2',
        ],
      }),
    );
  });

  it('does not let a caller override sessionIds', async () => {
    const reg = new SearchProviderRegistry();
    const search = jest.fn().mockResolvedValue(emptyResults);
    reg.register(mkProvider('builtin-fts', search));
    const svc = makeService(reg);

    await svc.search(
      {
        q: 'x',
        sessionIds: ['sneaky'],
      },
      SessionScopes.ids(['s1']),
    );

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionIds: ['s1'],
      }),
    );
  });

  it('includes deleted-session tombstones in OWNER scope', async () => {
    const reg = new SearchProviderRegistry();
    const search = jest.fn().mockResolvedValue(emptyResults);
    reg.register(mkProvider('builtin-fts', search));

    const { dataSource, mocks } = makeDataSource();
    mocks.sessionFind
      .mockResolvedValueOnce([{ id: 'live-a' }])
      .mockResolvedValueOnce([]);
    mocks.tombstoneFind.mockResolvedValueOnce([
      { sessionId: 'deleted-a' },
    ]);

    const svc = makeService(reg, dataSource);
    await svc.search(
      { q: 'history' },
      SessionScopes.owner('tl-a'),
    );

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionIds: expect.arrayContaining(['live-a', 'deleted-a']),
      }),
    );
  });

  it('gives a live Session precedence over a stale tombstone with the same id', async () => {
    const reg = new SearchProviderRegistry();
    const search = jest.fn().mockResolvedValue(emptyResults);
    reg.register(mkProvider('builtin-fts', search));

    const { dataSource, mocks } = makeDataSource();
    // The requested owner owns no live row, but does own a stale tombstone for reused-id.
    mocks.sessionFind
      .mockResolvedValueOnce([])
      // Existence probe finds a current live row irrespective of owner, so the tombstone must lose.
      .mockResolvedValueOnce([{ id: 'reused-id' }]);
    mocks.tombstoneFind.mockResolvedValueOnce([
      { sessionId: 'reused-id' },
    ]);

    const svc = makeService(reg, dataSource);
    const result = await svc.search(
      { q: 'history' },
      SessionScopes.owner('old-owner'),
    );

    expect(result).toEqual({
      hits: [],
      total: 0,
      tookMs: 0,
      provider: 'builtin-fts',
    });
    expect(search).not.toHaveBeenCalled();
  });

  it('applies OWNER_AND_IDS as an intersection to live and tombstoned sessions', async () => {
    const reg = new SearchProviderRegistry();
    const search = jest.fn().mockResolvedValue(emptyResults);
    reg.register(mkProvider('builtin-fts', search));

    const { dataSource, mocks } = makeDataSource();
    mocks.sessionFind
      .mockResolvedValueOnce([{ id: 'live-a' }])
      .mockResolvedValueOnce([]);
    mocks.tombstoneFind.mockResolvedValueOnce([{ sessionId: 'deleted-a' }]);

    const svc = makeService(reg, dataSource);
    await svc.search(
      { q: 'history' },
      SessionScopes.ownerAndIds('tl-a', ['live-a', 'deleted-a', 'foreign']),
    );

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionIds: expect.arrayContaining(['live-a', 'deleted-a']),
      }),
    );
    const sent = (search.mock.calls[0] as [{ sessionIds: string[] }])[0].sessionIds;
    expect(sent).not.toContain('foreign');
  });

  it('clamps an excessive limit to SEARCH_LIMIT_MAX before it reaches any provider', async () => {
    const reg = new SearchProviderRegistry();
    const search = jest.fn().mockResolvedValue(emptyResults);
    reg.register(mkProvider('builtin-fts', search));
    const svc = makeService(reg);

    await svc.search({ q: 'x', limit: 9999 }, ALL_SCOPE);
    const received = (search.mock.calls[0] as [{ limit: number }])[0].limit;
    expect(received).toBe(SEARCH_LIMIT_MAX);
    expect(received).toBeLessThan(9999);
  });

  it('clamps an excessive offset to SEARCH_OFFSET_MAX before it reaches any provider', async () => {
    const reg = new SearchProviderRegistry();
    const search = jest.fn().mockResolvedValue(emptyResults);
    reg.register(mkProvider('builtin-fts', search));
    const svc = makeService(reg);

    await svc.search({ q: 'x', offset: 99_999_999 }, ALL_SCOPE);
    const received = (search.mock.calls[0] as [{ offset: number }])[0].offset;
    expect(received).toBe(SEARCH_OFFSET_MAX);
    expect(received).toBeLessThan(99_999_999);
  });

  it('applies the default limit when the caller omits it', async () => {
    const reg = new SearchProviderRegistry();
    const search = jest.fn().mockResolvedValue(emptyResults);
    reg.register(mkProvider('builtin-fts', search));
    const svc = makeService(reg);

    await svc.search({ q: 'x' }, ALL_SCOPE);
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: SEARCH_DEFAULT_LIMIT,
      }),
    );
  });

  it('passes in-bounds limit/offset through unchanged', async () => {
    const reg = new SearchProviderRegistry();
    const search = jest.fn().mockResolvedValue(emptyResults);
    reg.register(mkProvider('builtin-fts', search));
    const svc = makeService(reg);

    await svc.search({ q: 'x', limit: 10, offset: 20 }, ALL_SCOPE);
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 10,
        offset: 20,
      }),
    );
  });
});
