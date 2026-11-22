import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { BraveBrowser } from './brave.browser';

describe('BraveBrowser (Phase 1)', () => {
  const driver = new BraveBrowser();
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'brave-driver-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('resolves an explicit existing executable before other candidates', async () => {
    const primary = path.join(tempRoot, 'brave');
    const legacy = path.join(tempRoot, 'legacy-brave');
    await fs.writeFile(primary, 'test');
    await fs.writeFile(legacy, 'test');
    await expect(driver.resolveExecutablePath({
      executablePath: primary,
      puppeteerExecutablePath: legacy,
    })).resolves.toBe(primary);
  });

  it('falls back to the Puppeteer path when the configured Brave path is missing', async () => {
    const fallback = path.join(tempRoot, 'brave-fallback');
    await fs.writeFile(fallback, 'test');
    await expect(driver.resolveExecutablePath({
      executablePath: path.join(tempRoot, 'not-installed'),
      puppeteerExecutablePath: fallback,
    })).resolves.toBe(fallback);
  });

  it('preserves the legacy supported Brave process-name detection', () => {
    expect(driver.matchesExecutable('/usr/bin/brave --user-data-dir=/profiles/a')).toBe(true);
    expect(driver.matchesExecutable('/usr/bin/brave-browser-stable --flag')).toBe(true);
    expect(driver.matchesExecutable('"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" --flag')).toBe(true);
    expect(driver.matchesExecutable('"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" --flag')).toBe(true);
    expect(driver.matchesExecutable('/usr/bin/google-chrome --user-data-dir=/profiles/brave')).toBe(false);
    expect(driver.matchesExecutable('/usr/bin/notbrave --flag')).toBe(false);
  });

  it('does not create application-owned session or lease arguments', () => {
    const args = driver.getBrowserSpecificArgs();
    expect(args).toEqual([]);
    expect(args).not.toContain('--al-hakim-session=account');
    expect(args).not.toContain('--al-hakim-lease=owner');
    expect(args).not.toContain('--user-data-dir=/profile');
  });
});

describe('Phase 7 strict browser-neutral executable override', () => {
  const driver = new BraveBrowser();

  it('accepts an executable with a registered Brave process identity', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase7-executable-'));
    const candidate = path.join(dir, 'brave');
    try {
      await fs.writeFile(candidate, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await fs.chmod(candidate, 0o755);
      await expect(driver.resolveExecutablePath({
        executablePath: candidate, strictExecutablePath: true,
      })).resolves.toBe(candidate);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a different browser executable name before launching', async () => {
    await expect(driver.resolveExecutablePath({
      executablePath: process.execPath, strictExecutablePath: true,
    })).rejects.toThrow(/does not match the Brave driver/);
  });

  it('refuses a missing explicit executable instead of using a valid fallback', async () => {
    await expect(driver.resolveExecutablePath({
      executablePath: path.join(os.tmpdir(), `missing-explicit-brave-${process.pid}`),
      puppeteerExecutablePath: process.execPath,
      strictExecutablePath: true,
    })).rejects.toThrow(/Explicit BROWSER_EXECUTABLE_PATH/);
  });

  it('refuses an explicit directory as a browser binary', async () => {
    await expect(driver.resolveExecutablePath({
      executablePath: os.tmpdir(), strictExecutablePath: true,
    })).rejects.toThrow(/Explicit BROWSER_EXECUTABLE_PATH/);
  });

  it('preserves legacy fallback when strict mode is not set', async () => {
    await expect(driver.resolveExecutablePath({
      executablePath: path.join(os.tmpdir(), `missing-legacy-brave-${process.pid}`),
      puppeteerExecutablePath: process.execPath,
    })).resolves.toBe(process.execPath);
  });
});
