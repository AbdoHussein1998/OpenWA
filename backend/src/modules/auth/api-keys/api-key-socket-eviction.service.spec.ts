import { ApiKeySocketEvictionService } from './api-key-socket-eviction.service';

describe('socket eviction port', () => {
  it('forwards key ID and security reason to the configured adapter', () => {
    const port = { evictApiKey: jest.fn() };
    const service = new ApiKeySocketEvictionService(port);
    service.evictActiveSockets('key-1', 'authorization_changed');
    expect(port.evictApiKey).toHaveBeenCalledWith('key-1', 'authorization_changed');
  });

  it('does not undo a committed DB mutation if the adapter fails', () => {
    const port = { evictApiKey: jest.fn(() => { throw new Error('socket offline'); }) };
    const service = new ApiKeySocketEvictionService(port);
    expect(() => service.evictActiveSockets('key-1', 'deleted')).not.toThrow();
  });
});
