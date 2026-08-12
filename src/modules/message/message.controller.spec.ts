import { MessageController } from './message.controller';
import type { MessageService } from './message.service';
import type { BulkMessageService } from './bulk-message.service';
import type { Response } from 'express';

/**
 * `getChatMedia` serves third-party bytes from the API origin. The route shape, the roles and the
 * status codes are already held by the OpenAPI snapshot and the route-fence gates; the two headers
 * that keep those bytes inert in a browser were held by nothing — deleting either line from the
 * controller passed every suite in the repo.
 */
describe('MessageController — stored media download', () => {
  const getChatMedia = jest.fn().mockResolvedValue({ buffer: Buffer.from('GIF89a'), mimetype: 'image/gif' });
  const controller = new MessageController(
    { getChatMedia } as unknown as MessageService,
    {} as unknown as BulkMessageService,
  );

  /**
   * Express merges the object form of `res.set` into the header bag, so accumulating is both closer
   * to the real thing than recording the last call and independent of how many calls the handler
   * splits its headers across.
   */
  const mediaResponseHeaders = async (): Promise<Record<string, string>> => {
    const headers: Record<string, string> = {};
    const res = { set: (fields: Record<string, string>) => Object.assign(headers, fields) } as unknown as Response;
    await controller.getChatMedia('session-1', '628123@c.us', 'msg-1', res);
    return headers;
  };

  it('sends nosniff, so a wrong Content-Type cannot be re-interpreted as active content', async () => {
    expect((await mediaResponseHeaders())['X-Content-Type-Options']).toBe('nosniff');
  });

  it('sends the media as an attachment, so it is never rendered on the API origin', async () => {
    expect((await mediaResponseHeaders())['Content-Disposition']).toBe('attachment');
  });
});
