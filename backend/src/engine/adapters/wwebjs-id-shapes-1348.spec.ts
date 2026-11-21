import { readWid } from '../types/whatsapp-web-js.types';
import { buildIncomingMessageBase, mapContactFields } from './message-mapper';

describe('WhatsApp Web renamed ID shape', () => {
  it('normalizes _serialized and $1 consistently', () => {
    expect(readWid({ _serialized: 'abc@c.us' })).toBe('abc@c.us');
    expect(readWid({ $1: 'xyz@lid' })).toBe('xyz@lid');
    expect(readWid('120@g.us')).toBe('120@g.us');
  });
  it('preserves incoming message id and contact id on a $1-only build', () => {
    const message = buildIncomingMessageBase({
      id: { $1: 'true_abc@c.us_MSG' }, from: 'abc@c.us', to: 'me@c.us',
      body: 'hello', type: 'chat', timestamp: 1700000000, fromMe: false,
    });
    expect(message.id).toBe('true_abc@c.us_MSG');
    expect(mapContactFields({ id: { $1: 'abc@c.us' } }, true).id).toBe('abc@c.us');
  });
});
