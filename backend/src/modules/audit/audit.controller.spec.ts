



import { Reflector } from '@nestjs/core';

import {
  ApiCapability,
} from '../auth/capabilities/api-capability';
import {
  REQUIRED_CAPABILITY_KEY,
} from '../auth/decorators/capability.decorator';
import {
  UNSCOPED_KEY,
} from '../auth/decorators/auth.decorators';

import {
  AuditController,
} from './audit.controller';

describe('AuditController access control', () => {
  const reflector = new Reflector();

  it('requires AUDIT_READ at the controller level', () => {
    expect(
      reflector.get<ApiCapability | undefined>(
        REQUIRED_CAPABILITY_KEY,
        AuditController,
      ),
    ).toBe(ApiCapability.AUDIT_READ);
  });

  it('does not require an unscoped key so scoped administrative keys can read only their permitted Session audit rows', () => {
    expect(
      reflector.get<boolean | undefined>(
        UNSCOPED_KEY,
        AuditController,
      ),
    ).toBeUndefined();
  });
});




