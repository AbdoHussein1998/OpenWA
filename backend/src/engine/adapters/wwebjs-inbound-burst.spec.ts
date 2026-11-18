import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { withInboundDownloadTimeout } from './inbound-media-cap';

/**
 * The whatsapp-web.js half of the inbound-media burst bound.
 *
 * `baileys-inbound-burst.spec.ts` pins the same property on the other engine, where a queue cap
 * equal to the active slots made admission a constant 8 whatever the batch size, so a burst lost
 * the media of everything past the eighth. The whatsapp-web.js adapter carried the identical
 * construction and kept losing media the same way after the Baileys side was repaired.
 *
 * The download alone runs inside the limiter, and waiting admission has a separate timeout.
 * A finite queue is needed because downloads may never settle after the page stalls.
 *
 * A hung download retains its active slot until the real promise settles, even after a caller
 * deadline. Queue overflow must fail fast so the adapter can emit a declared-only media marker
 * rather than holding another message indefinitely. The caller deadline remains an independent
 * bound covering both waiting time and download time.
 */
describe('whatsapp-web.js inbound media burst', () => {
  it('bounds queued media admission so a stalled browser cannot retain unlimited Messages', () => {
    const source = readFileSync(join(__dirname, 'whatsapp-web-js.adapter.ts'), 'utf8');
    expect(source).toMatch(/new ConcurrencyLimiter\(\s*inboundMediaConcurrency\(\),\s*inboundMediaMaxQueued\(\)/);
  });

  it('drops excess work without evicting active downloads, and closes pending work', async () => {
    const limiter = new ConcurrencyLimiter(1, 1);
    const never = new Promise<void>(() => undefined);
    void limiter.run(() => never);
    const pending = limiter.run(async () => undefined);
    await expect(limiter.run(async () => undefined)).rejects.toThrow('queue full');
    expect(limiter.activeCount).toBe(1);
    expect(limiter.queuedCount).toBe(1);
    limiter.close();
    await expect(pending).rejects.toThrow('closed');
    expect(limiter.queuedCount).toBe(0);
  });

  it('bounds the caller wait, so a message behind permanently stuck slots still resolves', async () => {
    // The real composition: a limiter whose slots never free, and a caller awaiting admission.
    const limiter = new ConcurrencyLimiter(1);
    const wedged = new Promise<never>(() => undefined); // a download that never settles
    void limiter.run(() => wedged); // takes the only slot and keeps it

    let admitted = false;
    const boundedReady = limiter.run(() => {
      admitted = true;
      return Promise.resolve({ data: 'QUJD', mimetype: 'image/jpeg' });
    });

    const media = await withInboundDownloadTimeout(boundedReady, 25);

    expect(admitted).toBe(false); // it never got a slot...
    expect(media).toBeNull(); // ...and the caller still unblocked, to emit without media
  });

  it('wraps the caller wait in the timeout rather than only the admitted download', () => {
    // Structural, because the behaviour above is composition-level: the inner race starts once the
    // task is ADMITTED, so it cannot cover the queue wait. Awaiting boundedReady bare is the shape
    // that reintroduces the unbounded wait.
    const source = readFileSync(join(__dirname, 'whatsapp-web-js.adapter.ts'), 'utf8');

    expect(source).toMatch(/await\s+withInboundDownloadTimeout\(\s*boundedReady\s*,/);
    expect(source).not.toMatch(/const\s+media\s*=\s*await\s+boundedReady\s*;/);
  });
});
