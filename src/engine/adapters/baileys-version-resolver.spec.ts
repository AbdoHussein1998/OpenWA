import * as fs from 'fs';
import * as path from 'path';
import { BaileysVersionResolver, DEFAULT_FALLBACK_WA_VERSION } from './baileys-version-resolver';

describe('BaileysVersionResolver', () => {
  const tempDir = path.join(__dirname, '../../../test/tmp-resolver-test');
  const cacheFile = path.join(tempDir, 'last_known_wa_version.json');
  const originalEnv = process.env.BAILEYS_WA_VERSION;

  const mockLogger = {
    log: jest.fn(),
    warn: jest.fn(),
  };

  const createResolver = () =>
    new BaileysVersionResolver({
      authDir: tempDir,
      sessionId: 'test-session',
      logger: mockLogger,
    });

  beforeEach(() => {
    delete process.env.BAILEYS_WA_VERSION;
    jest.clearAllMocks();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    if (originalEnv) {
      process.env.BAILEYS_WA_VERSION = originalEnv;
    } else {
      delete process.env.BAILEYS_WA_VERSION;
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('when BAILEYS_WA_VERSION is set with dots, returns the overridden version', async () => {
    // Arrange
    process.env.BAILEYS_WA_VERSION = '2.3000.1045340097';
    const resolver = createResolver();
    const mockLib = {
      fetchLatestWaWebVersion: jest.fn(),
      fetchLatestBaileysVersion: jest.fn(),
    };

    // Act
    const version = await resolver.resolve(mockLib as any);

    // Assert
    expect(version).toEqual([2, 3000, 1045340097]);
    expect(mockLib.fetchLatestWaWebVersion).not.toHaveBeenCalled();
    expect(mockLib.fetchLatestBaileysVersion).not.toHaveBeenCalled();
  });

  it('when BAILEYS_WA_VERSION is set with commas, returns the overridden version', async () => {
    // Arrange
    process.env.BAILEYS_WA_VERSION = '2,3000,1045340097';
    const resolver = createResolver();
    const mockLib = {
      fetchLatestWaWebVersion: jest.fn(),
      fetchLatestBaileysVersion: jest.fn(),
    };

    // Act
    const version = await resolver.resolve(mockLib as any);

    // Assert
    expect(version).toEqual([2, 3000, 1045340097]);
  });

  it('when fetchLatestWaWebVersion succeeds, resolves and writes version to disk cache', async () => {
    // Arrange
    const resolver = createResolver();
    const mockLib = {
      fetchLatestWaWebVersion: jest.fn().mockResolvedValue({ version: [2, 3000, 1045340097], isLatest: true }),
      fetchLatestBaileysVersion: jest.fn(),
    };

    // Act
    const version = await resolver.resolve(mockLib as any);

    // Assert
    expect(version).toEqual([2, 3000, 1045340097]);
    expect(mockLib.fetchLatestWaWebVersion).toHaveBeenCalled();
    expect(mockLib.fetchLatestBaileysVersion).not.toHaveBeenCalled();
    expect(fs.existsSync(cacheFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))).toEqual([2, 3000, 1045340097]);
  });

  it('when fetchLatestWaWebVersion fails, falls back to fetchLatestBaileysVersion and caches it', async () => {
    // Arrange
    const resolver = createResolver();
    const mockLib = {
      fetchLatestWaWebVersion: jest.fn().mockRejectedValue(new Error('WA Web connection timeout')),
      fetchLatestBaileysVersion: jest.fn().mockResolvedValue({ version: [2, 3000, 1043857760], isLatest: true }),
    };

    // Act
    const version = await resolver.resolve(mockLib as any);

    // Assert
    expect(version).toEqual([2, 3000, 1043857760]);
    expect(mockLib.fetchLatestWaWebVersion).toHaveBeenCalled();
    expect(mockLib.fetchLatestBaileysVersion).toHaveBeenCalled();
    expect(fs.existsSync(cacheFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))).toEqual([2, 3000, 1043857760]);
  });

  it('when remote fetches fail and valid disk cache exists, returns cached version', async () => {
    // Arrange
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify([2, 3000, 888888]), 'utf8');

    const resolver = createResolver();
    const mockLib = {
      fetchLatestWaWebVersion: jest.fn().mockRejectedValue(new Error('offline')),
      fetchLatestBaileysVersion: jest.fn().mockRejectedValue(new Error('github 503')),
    };

    // Act
    const version = await resolver.resolve(mockLib as any);

    // Assert
    expect(version).toEqual([2, 3000, 888888]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Using cached WhatsApp Web version from disk: 2.3000.888888'),
      expect.anything()
    );
  });

  it('when network fetches fail and disk cache is missing, returns DEFAULT_FALLBACK_WA_VERSION', async () => {
    // Arrange
    const resolver = createResolver();
    const mockLib = {
      fetchLatestWaWebVersion: jest.fn().mockRejectedValue(new Error('offline')),
      fetchLatestBaileysVersion: jest.fn().mockRejectedValue(new Error('github down')),
    };

    // Act
    const version = await resolver.resolve(mockLib as any);

    // Assert
    expect(version).toEqual(DEFAULT_FALLBACK_WA_VERSION);
  });
});
