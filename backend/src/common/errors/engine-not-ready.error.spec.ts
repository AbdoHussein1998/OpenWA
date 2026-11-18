import { EngineNotReadyError } from './engine-not-ready.error';

describe('EngineNotReadyError', () => {
  it('keeps the generic not-ready contract machine-readable', () => {
    const error = new EngineNotReadyError();

    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
      code: 'ENGINE_NOT_READY',
      message: 'Session is not connected. The WhatsApp client is not ready.',
    });
  });

  it('can identify the temporary whatsapp-web.js reinjection window', () => {
    const error = new EngineNotReadyError(
      'WhatsApp Web is reloading its page and the session is re-injecting. Retry in a few seconds.',
      'ENGINE_REINJECTING',
    );

    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
      code: 'ENGINE_REINJECTING',
    });
  });
});
