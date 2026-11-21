import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendTextMessageDto, SendMediaMessageDto } from './send-message.dto';
import { SendTemplateMessageDto } from './send-template.dto';
import { SendLocationDto, SendContactDto, SendPollDto, ReplyMessageDto, ForwardMessageDto } from './message-actions.dto';

/** The global ValidationPipe has whitelist+forbidNonWhitelisted; key must survive both. */
describe('Phase 3 idempotency key DTO contract', () => {
  const samples: Array<[new () => object, Record<string, unknown>]> = [
    [SendTextMessageDto, { chatId: '628123@c.us', text: 'hi' }],
    [SendMediaMessageDto, { chatId: '628123@c.us', url: 'https://example.com/a.png' }],
    [SendTemplateMessageDto, { chatId: '628123@c.us', templateName: 'welcome' }],
    [SendLocationDto, { chatId: '628123@c.us', latitude: -6.2, longitude: 106.8 }],
    [SendContactDto, { chatId: '628123@c.us', contactName: 'Alice', contactNumber: '628123' }],
    [SendPollDto, { chatId: '628123@c.us', name: 'Q?', options: ['Yes', 'No'] }],
    [ReplyMessageDto, { chatId: '628123@c.us', quotedMessageId: 'abc', text: 'hi' }],
    [ForwardMessageDto, { fromChatId: '628123@c.us', toChatId: '628456@c.us', messageId: 'abc' }],
  ];

  it.each(samples)('accepts valid key in %s', async (dtoClass, sample) => {
    const dto = plainToInstance(dtoClass, { ...sample, idempotencyKey: 'request-00001' });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toHaveLength(0);
    expect((dto as { idempotencyKey?: string }).idempotencyKey).toBe('request-00001');
  });

  it.each(samples)('rejects invalid key in %s', async (dtoClass, sample) => {
    const dto = plainToInstance(dtoClass, { ...sample, idempotencyKey: 'bad key' });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.some(err => err.property === 'idempotencyKey')).toBe(true);
  });
});
