import { WwebjsMessaging, toMessageResult } from './wwebjs-messaging';
import { SendOutcomeUncertainError } from '../../common/errors/send-outcome-uncertain.error';

describe('WwebjsMessaging uncertain send behavior', () => {
  it('never performs a second send when No LID for user follows a first dispatch', async () => {
    const send = jest.fn().mockRejectedValue(new Error('No LID for user'));
    const messaging = new WwebjsMessaging({
      getNumberId: jest.fn().mockResolvedValueOnce('111@c.us').mockResolvedValueOnce('111@lid'),
      reportIfPageTransportError: jest.fn(),
      logger: { warn: jest.fn() },
      config: { sessionId: 'profile1' },
    } as never);
    // Exercise the private helper directly to isolate the no-duplicate-send invariant.
    await expect((messaging as unknown as {
      sendResolved: (chatId: string, send: (to: string) => Promise<unknown>) => Promise<unknown>;
    }).sendResolved('111@c.us', send)).rejects.toBeInstanceOf(SendOutcomeUncertainError);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('111@c.us');
  });

  it('reports missing send result as an error, not a false success', () => {
    expect(() => toMessageResult(undefined)).toThrow('may not have been delivered');
  });
});
