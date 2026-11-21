import { BadRequestException } from '@nestjs/common';
import { sendIdempotencyFields } from './send-idempotency.util';

describe('sendIdempotencyFields', () => {
  it('preserves unkeyed sends unchanged', () => {
    expect(sendIdempotencyFields('text', { chatId: 'a@c.us', text: 'hi' })).toEqual({});
  });
  it('canonicalizes property order and does not include the key in the payload hash', () => {
    const a = sendIdempotencyFields('text', {
      idempotencyKey: 'req-0000001', chatId: 'a@c.us', nested: { b: 1, a: 2 },
    });
    const b = sendIdempotencyFields('text', {
      nested: { a: 2, b: 1 }, chatId: 'a@c.us', idempotencyKey: 'req-0000002',
    });
    expect(a.sendRequestHash).toBe(b.sendRequestHash);
  });
  it('changes the fingerprint for action, destination, or text changes', () => {
    const base = { idempotencyKey: 'req-0000001', chatId: 'a@c.us', text: 'hi' };
    const original = sendIdempotencyFields('text', base).sendRequestHash;
    expect(sendIdempotencyFields('reply', base).sendRequestHash).not.toBe(original);
    expect(sendIdempotencyFields('text', { ...base, chatId: 'b@c.us' }).sendRequestHash).not.toBe(original);
    expect(sendIdempotencyFields('text', { ...base, text: 'different' }).sendRequestHash).not.toBe(original);
  });
  it.each(['', 'short', ' spaces-000', '\nreq-000001', 'a'.repeat(129)])(
    'rejects invalid idempotencyKey %j before sending', key => {
      expect(() => sendIdempotencyFields('text', { idempotencyKey: key })).toThrow(BadRequestException);
    },
  );
});
