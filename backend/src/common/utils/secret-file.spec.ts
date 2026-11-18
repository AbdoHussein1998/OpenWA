import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeSecretFile } from './secret-file';

describe('writeSecretFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'owa-secret-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const mode = (p: string): number => statSync(p).mode & 0o777;
  const expectOwnerOnly = (p: string): void => {
    expect(existsSync(p)).toBe(true);
    if (process.platform !== 'win32') {
      expect(mode(p) & 0o077).toBe(0);
    }
  };

  it('writes a new secret file owner-only (no group/other access)', () => {
    const p = join(dir, 'secret');
    writeSecretFile(p, 'topsecret');
    expectOwnerOnly(p);
    expect(readFileSync(p, 'utf8')).toBe('topsecret');
  });

  it('tightens an already-existing world-readable file (writeFileSync mode only applies on create)', () => {
    const p = join(dir, 'legacy');
    writeFileSync(p, 'old', { mode: 0o644 });
    if (process.platform !== 'win32') {
      expect(mode(p) & 0o077).not.toBe(0); // precondition: loose
    }

    writeSecretFile(p, 'new');
    expectOwnerOnly(p);
    expect(readFileSync(p, 'utf8')).toBe('new');
  });

  it('does not warn about ENOENT when first creating a secret file', () => {
    const p = join(dir, 'ghost');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      writeSecretFile(p, 'secret');
      expect(warnSpy).not.toHaveBeenCalled();
      expectOwnerOnly(p);
      expect(readFileSync(p, 'utf8')).toBe('secret');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warns on an actual permission failure before overwriting an existing secret', () => {
    const fs = jest.requireActual<typeof import('fs')>('fs');
    const p = join(dir, 'existing-secret');
    writeFileSync(p, 'old', { mode: 0o600 });
    const chmod = jest.spyOn(fs, 'chmodSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      writeSecretFile(p, 'updated');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('pre-write chmod 0o600 failed'));
      expect(readFileSync(p, 'utf8')).toBe('updated');
    } finally {
      chmod.mockRestore();
      warn.mockRestore();
    }
  });
});
