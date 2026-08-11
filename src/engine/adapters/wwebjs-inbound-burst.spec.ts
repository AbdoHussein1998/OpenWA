import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The whatsapp-web.js half of the inbound-media burst bound.
 *
 * `baileys-inbound-burst.spec.ts` pins the same property on the other engine, where a queue cap
 * equal to the active slots made admission a constant 8 whatever the batch size, so a burst lost
 * the media of everything past the eighth. The whatsapp-web.js adapter carried the identical
 * construction — `new ConcurrencyLimiter(inboundMediaConcurrency(), inboundMediaConcurrency())` —
 * and kept losing media in exactly the same way after the Baileys side was repaired.
 *
 * Unbounding the queue is safe here for a reason that does not hold on Baileys: only the DOWNLOAD
 * runs inside the limiter, not the whole message pipeline, and each message awaits its own
 * `capInboundMediaFor`. A parked download therefore delays that message alone — a text message
 * never enters the limiter at all.
 */
describe('whatsapp-web.js inbound media burst', () => {
  it('gives the inbound limiter an unbounded queue, so a burst parks instead of shedding', () => {
    const source = readFileSync(join(__dirname, 'whatsapp-web-js.adapter.ts'), 'utf8');
    const construction = source.match(/new ConcurrencyLimiter\(([\s\S]*?)\);/);

    // Guard the parser: a renamed limiter would make this vacuous.
    expect(construction).not.toBeNull();

    const args = (construction?.[1] ?? '')
      .split(',')
      .map(arg => arg.replace(/\/\/[^\n]*/g, '').trim())
      .filter(Boolean);
    expect(args).toEqual(['inboundMediaConcurrency()']);
  });
});
