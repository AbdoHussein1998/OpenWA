import * as fs from 'fs';
import * as path from 'path';
import type * as BaileysLib from '@whiskeysockets/baileys';
import type { LoggerService } from '../../common/services/logger.service';

export type WAVersion = [number, number, number];

/** Default modern fallback version when all remote endpoints and local caches are unavailable */
export const DEFAULT_FALLBACK_WA_VERSION: WAVersion = [2, 3000, 1045340097];

export interface BaileysVersionResolverOptions {
  authDir: string;
  sessionId: string;
  logger: Pick<LoggerService, 'log' | 'warn'>;
}

/**
 * Resilient WhatsApp Web protocol version resolver.
 *
 * Implements multi-tier resolution:
 * 1. BAILEYS_WA_VERSION operator environment override
 * 2. Direct WhatsApp Web service worker endpoint (fetchLatestWaWebVersion -> web.whatsapp.com/sw.js)
 * 3. Upstream repository Defaults/index.ts (fetchLatestBaileysVersion -> GitHub raw)
 * 4. Local disk cache (last_known_wa_version.json in authDir)
 * 5. Safe modern fallback version
 */
export class BaileysVersionResolver {
  private readonly cacheFilePath: string;

  constructor(private readonly options: BaileysVersionResolverOptions) {
    this.cacheFilePath = path.join(this.options.authDir, 'last_known_wa_version.json');
  }

  async resolve(b: typeof BaileysLib): Promise<WAVersion> {
    const envVersion = this.resolveFromEnv();
    if (envVersion) {
      return envVersion;
    }

    const waWebVersion = await this.resolveFromWaWeb(b);
    if (waWebVersion) {
      return waWebVersion;
    }

    const baileysVersion = await this.resolveFromBaileys(b);
    if (baileysVersion) {
      return baileysVersion;
    }

    const cachedVersion = this.resolveFromDiskCache();
    if (cachedVersion) {
      return cachedVersion;
    }

    return DEFAULT_FALLBACK_WA_VERSION;
  }

  private resolveFromEnv(): WAVersion | null {
    const raw = process.env.BAILEYS_WA_VERSION?.trim();
    if (!raw) {
      return null;
    }

    const parts = raw.split(/[.,]/).map(p => parseInt(p.trim(), 10));
    if (parts.length === 3 && parts.every(n => !isNaN(n) && n >= 0)) {
      this.options.logger.log(`Using BAILEYS_WA_VERSION override: ${parts.join('.')}`, {
        sessionId: this.options.sessionId,
      });
      return parts as WAVersion;
    }

    this.options.logger.warn(`Invalid BAILEYS_WA_VERSION format "${raw}", expected "major.minor.patch"`, {
      sessionId: this.options.sessionId,
    });
    return null;
  }

  private async resolveFromWaWeb(b: typeof BaileysLib): Promise<WAVersion | null> {
    if (typeof b.fetchLatestWaWebVersion !== 'function') {
      return null;
    }

    try {
      const result = await b.fetchLatestWaWebVersion();
      if (this.isValidVersion(result?.version)) {
        const version = result.version as WAVersion;
        this.saveCachedVersion(version);
        return version;
      }
    } catch (err) {
      this.options.logger.warn(`fetchLatestWaWebVersion failed: ${err instanceof Error ? err.message : String(err)}`, {
        sessionId: this.options.sessionId,
      });
    }

    return null;
  }

  private async resolveFromBaileys(b: typeof BaileysLib): Promise<WAVersion | null> {
    if (typeof b.fetchLatestBaileysVersion !== 'function') {
      return null;
    }

    try {
      const result = await b.fetchLatestBaileysVersion();
      if (this.isValidVersion(result?.version)) {
        const version = result.version as WAVersion;
        this.saveCachedVersion(version);
        return version;
      }
    } catch (err) {
      this.options.logger.warn(`fetchLatestBaileysVersion failed: ${err instanceof Error ? err.message : String(err)}`, {
        sessionId: this.options.sessionId,
      });
    }

    return null;
  }

  private resolveFromDiskCache(): WAVersion | null {
    try {
      if (!fs.existsSync(this.cacheFilePath)) {
        return null;
      }

      const content = fs.readFileSync(this.cacheFilePath, 'utf8');
      const parsed = JSON.parse(content);
      if (this.isValidVersion(parsed)) {
        this.options.logger.warn(`Using cached WhatsApp Web version from disk: ${parsed.join('.')}`, {
          sessionId: this.options.sessionId,
        });
        return parsed as WAVersion;
      }
    } catch {
      // Non-blocking disk read fallback
    }

    return null;
  }

  private saveCachedVersion(version: WAVersion): void {
    try {
      const dir = path.dirname(this.cacheFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.cacheFilePath, JSON.stringify(version), 'utf8');
    } catch {
      // Non-blocking best-effort caching
    }
  }

  private isValidVersion(v: unknown): v is WAVersion {
    return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && !isNaN(n) && n >= 0);
  }
}
