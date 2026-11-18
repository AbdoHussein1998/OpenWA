import {
  BadRequestException,
  NotImplementedException,
} from '@nestjs/common';

import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchQueryDto } from './dto/search-query.dto';

import type { ApiKey } from '../auth/entities/api-key.entity';
import type { SessionTenantAccessService } from '../access-control/session-tenant-access.service';
import {
  SessionScopes,
  type SessionScope,
} from '../access-control/session-scope';

import type { SearchResults } from './search.types';

describe('SearchController', () => {
  const search = jest.fn();
  const getEffectiveSessionScope = jest.fn();

  const ctrl = new SearchController(
    { search } as unknown as SearchService,
    {
      getEffectiveSessionScope,
    } as unknown as SessionTenantAccessService,
  );

  const ok = {
    hits: [],
    total: 0,
    tookMs: 1,
    provider: 'builtin-fts',
  } satisfies SearchResults;

  const apiKey = {
    id: 'k1',
  } as unknown as ApiKey;

  beforeEach(() => {
    search.mockReset();
    getEffectiveSessionScope.mockReset();
  });

  it('throws 400 when q is empty', async () => {
    const dto: SearchQueryDto = {
      q: '',
    };

    await expect(
      ctrl.search(
        dto,
        apiKey,
      ),
    ).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(
      getEffectiveSessionScope,
    ).not.toHaveBeenCalled();

    expect(search).not.toHaveBeenCalled();
  });

  it('throws 400 when q is only whitespace', async () => {
    // @IsNotEmpty() on the DTO passes for '   ' (non-empty), so the controller's own trim guard is
    // what rejects whitespace-only q — this test pins that guard in place.
    const dto: SearchQueryDto = {
      q: '   ',
    };

    await expect(
      ctrl.search(
        dto,
        apiKey,
      ),
    ).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(
      getEffectiveSessionScope,
    ).not.toHaveBeenCalled();

    expect(search).not.toHaveBeenCalled();
  });

  it('returns results and forwards the effective SessionScope', async () => {
    search.mockResolvedValue(ok);

    const scope: SessionScope =
      SessionScopes.ids([
        's1',
        's2',
      ]);

    getEffectiveSessionScope.mockResolvedValue(
      scope,
    );

    const dto: SearchQueryDto = {
      q: 'hello',
      limit: 5,
    };

    const res = await ctrl.search(
      dto,
      apiKey,
    );

    expect(
      getEffectiveSessionScope,
    ).toHaveBeenCalledWith(
      apiKey,
    );

    expect(search).toHaveBeenCalledWith(
      dto,
      scope,
    );

    expect(res).toBe(ok);
  });

  it('forwards ALL for an unrestricted key', async () => {
    search.mockResolvedValue(ok);

    const scope =
      SessionScopes.all();

    getEffectiveSessionScope.mockResolvedValue(
      scope,
    );

    const dto: SearchQueryDto = {
      q: 'hello',
    };

    await ctrl.search(
      dto,
      apiKey,
    );

    expect(search).toHaveBeenCalledWith(
      dto,
      scope,
    );
  });

  it('takes authorization scope only from SessionTenantAccessService; query sessionId can only narrow later', async () => {
    search.mockResolvedValue(ok);

    const scope =
      SessionScopes.ids([
        's1',
      ]);

    getEffectiveSessionScope.mockResolvedValue(
      scope,
    );

    const dto: SearchQueryDto = {
      q: 'hello',
      sessionId: 's2',
    };

    await ctrl.search(
      dto,
      apiKey,
    );

    expect(
      getEffectiveSessionScope,
    ).toHaveBeenCalledWith(
      apiKey,
    );

    expect(search).toHaveBeenCalledWith(
      dto,
      scope,
    );
  });

  it('propagates 501 (NotImplementedException) from the service when no provider is active', async () => {
    const scope =
      SessionScopes.all();

    getEffectiveSessionScope.mockResolvedValue(
      scope,
    );

    search.mockRejectedValue(
      new NotImplementedException(
        'none',
      ),
    );

    await expect(
      ctrl.search(
        {
          q: 'x',
        },
        apiKey,
      ),
    ).rejects.toBeInstanceOf(
      NotImplementedException,
    );
  });
});
