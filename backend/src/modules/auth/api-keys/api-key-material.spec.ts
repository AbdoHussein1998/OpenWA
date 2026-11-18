import { createCredentialMaterial, hashCredential } from './api-key-material';

describe('API-key secret material', () => {
  const originalPepper = process.env.API_KEY_PEPPER;

  afterEach(() => {
    if (originalPepper === undefined) delete process.env.API_KEY_PEPPER;
    else process.env.API_KEY_PEPPER = originalPepper;
  });

  it('generates a unique secret and stores only its hash and public prefix', () => {
    const first = createCredentialMaterial();
    const second = createCredentialMaterial();
    expect(first.rawKey).toMatch(/^owa_k1_[0-9a-f]{64}$/);
    expect(first.rawKey).not.toEqual(second.rawKey);
    expect(first.keyPrefix).toEqual(first.rawKey.substring(0, 12));
    expect(first.keyHash).toEqual(hashCredential(first.rawKey));
    expect(first.keyHash).not.toEqual(first.rawKey);
  });

  it('uses the configured pepper consistently for bootstrap and rotation', () => {
    const rawKey = 'owa_k1_manual-test';
    process.env.API_KEY_PEPPER = 'pepper-one';
    const first = createCredentialMaterial(rawKey);
    process.env.API_KEY_PEPPER = 'pepper-two';
    const second = createCredentialMaterial(rawKey);
    expect(first.keyHash).not.toEqual(second.keyHash);
  });
});
