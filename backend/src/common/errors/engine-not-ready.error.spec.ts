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

  it('identifies an unavailable WhatsApp Web event bridge with its own 409 code', () => {
    const error = new EngineNotReadyError(
      'WhatsApp Web message event bridge is not ready. Retry after reinjection or reconnect.',
      'ENGINE_EVENT_BRIDGE_NOT_READY',
    );

    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
      code: 'ENGINE_EVENT_BRIDGE_NOT_READY',
    });
  });
});
