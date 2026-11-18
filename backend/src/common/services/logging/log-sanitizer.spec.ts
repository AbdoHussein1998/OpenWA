import { safeLogError, sanitizeLogMetadata, sanitizeLogText } from './log-sanitizer';

describe('Logging transport sanitizer', () => {
  it('redacts nested secrets and QR material before either transport', () => {
    const data = sanitizeLogMetadata({
      sessionId: 'test-session', qr: '2@THIS_IS_QR_SECRET_VALUE',
      nested: { config: { apiKey: 'private-key', cookie: 'session-cookie', host: 'local' } },
    });
    expect(data.sessionId).toBe('test-session');
    expect(data.qr).toBe('[REDACTED]');
    expect(JSON.stringify(data)).not.toContain('private-key');
    expect(JSON.stringify(data)).not.toContain('session-cookie');
  });

  it('retains bounded Nest logger class names without leaking arbitrary context strings', () => {
    expect(sanitizeLogMetadata({ context: 'NestFramework' }).context).toBe('NestFramework');
    expect(sanitizeLogMetadata({ context: 'ExceptionsHandler' }).context).toBe('ExceptionsHandler');
    expect(sanitizeLogMetadata({ context: 'token=VERYSECRET' }).context).toBe('[REDACTED]');
    expect(sanitizeLogMetadata({ context: "auth user secret content" }).context).toBe('[REDACTED]');
    expect(sanitizeLogMetadata({ nested: { context: 'NestFramework' } }).nested).toEqual({ context: '[REDACTED]' });
  });

  it('sanitizes token-like plain text and URL credentials', () => {
    expect(sanitizeLogText('Authorization: Bearer SOMESECRET')).not.toContain('SOMESECRET');
    expect(sanitizeLogText('http://alice:password@example.test/')).not.toContain('alice:password');
    expect(sanitizeLogText('token=XYZ123')).not.toContain('XYZ123');
  });

  it('survives cyclic objects and malformed metadata', () => {
    const nested: Record<string, unknown> = {};
    nested.self = nested;
    expect(() => sanitizeLogMetadata({ nested })).not.toThrow();
    expect(JSON.stringify(sanitizeLogMetadata({ nested }))).toContain('[CIRCULAR]');
  });

  it('retains classified error evidence without raw credential strings', () => {
    const error = new Error('Request failed token=PRIVATEVALUE');
    const safe = safeLogError(error);
    expect(safe.message).not.toContain('PRIVATEVALUE');
    expect(safe.name).toBe('Error');
  });
});
