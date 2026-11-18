import { ForbiddenException } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { SessionScopes } from '../access-control/session-scope';

describe('AuditController effective tenant scope', () => {
  const key = { id: 'key-1', allowedSessions: ['s1'] } as never;

  it('derives the scope from tenant authorization, not from user input or a partial key field', async () => {
    const audit = { findAll: jest.fn().mockResolvedValue({ data: [], total: 0 }) };
    const tenant = {
      getHistoricalSessionQueryScope: jest.fn().mockResolvedValue(SessionScopes.ids(['s1'])),
    };
    const controller = new AuditController(audit as never, tenant as never);
    await controller.findAll(key, undefined, undefined, 's1');
    expect(tenant.getHistoricalSessionQueryScope).toHaveBeenCalledWith(key);
    expect(audit.findAll).toHaveBeenCalledWith({ sessionId: 's1' }, SessionScopes.ids(['s1']));
  });

  it('rejects missing actor even if a future adapter forgets the HTTP guard', async () => {
    const audit = { findAll: jest.fn() };
    const tenant = { getHistoricalSessionQueryScope: jest.fn() };
    const controller = new AuditController(audit as never, tenant as never);
    await expect(controller.findAll()).rejects.toThrow(ForbiddenException);
    expect(audit.findAll).not.toHaveBeenCalled();
  });
});
