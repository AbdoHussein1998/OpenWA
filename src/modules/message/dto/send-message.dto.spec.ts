import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendTextMessageDto, SendMediaMessageDto, SEND_TEXT_BODY_EXAMPLES } from './send-message.dto';

// Mirror the global ValidationPipe (main.ts): whitelist + forbidNonWhitelisted strip/reject unknown props.
const validateDto = (cls: new () => object, obj: unknown) =>
  validate(plainToInstance(cls, obj), { whitelist: true, forbidNonWhitelisted: true });

describe('SendTextMessageDto mentions', () => {
  it('accepts an optional array of mention WIDs', async () => {
    const errors = await validateDto(SendTextMessageDto, {
      chatId: 'g@g.us',
      text: 'hi @62811',
      mentions: ['62811@c.us'],
    });
    expect(errors).toHaveLength(0);
  });

  it('is omittable (mentions stays optional)', async () => {
    const errors = await validateDto(SendTextMessageDto, { chatId: 'g@g.us', text: 'hi' });
    expect(errors).toHaveLength(0);
  });

  it('rejects a non-string element in mentions', async () => {
    const errors = await validateDto(SendTextMessageDto, {
      chatId: 'g@g.us',
      text: 'hi',
      mentions: [123],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an oversized mentions array (> 1024 entries)', async () => {
    const errors = await validateDto(SendTextMessageDto, {
      chatId: 'g@g.us',
      text: 'hi',
      mentions: Array.from({ length: 1025 }, (_, i) => `${i}@c.us`),
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a mention WID longer than the per-element cap', async () => {
    const errors = await validateDto(SendTextMessageDto, {
      chatId: 'g@g.us',
      text: 'hi',
      mentions: ['a'.repeat(65) + '@c.us'],
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});

// These examples are what Swagger UI pre-fills into "Try it out", so a caller who changes nothing
// submits them verbatim. Left to the schema sampler the body paired `linkPreview: false` with a
// `customLinkPreview` and every Try-it click 400'd (#1068); these assertions are what keeps a new
// optional field from quietly recreating an unusable default.
describe('SEND_TEXT_BODY_EXAMPLES', () => {
  const entries = Object.entries(SEND_TEXT_BODY_EXAMPLES);

  it('declares at least one example', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)('%s passes DTO validation', async (_name, example) => {
    const errors = await validateDto(SendTextMessageDto, example.value);
    expect(errors).toHaveLength(0);
  });

  it.each(entries)('%s does not combine linkPreview:false with customLinkPreview', (_name, example) => {
    const value = example.value as { linkPreview?: boolean; customLinkPreview?: unknown };
    expect(value.linkPreview === false && value.customLinkPreview !== undefined).toBe(false);
  });
});

describe('SendMediaMessageDto mentions', () => {
  it('accepts an optional array of mention WIDs', async () => {
    const errors = await validateDto(SendMediaMessageDto, {
      chatId: 'g@g.us',
      url: 'https://example.com/a.jpg',
      caption: 'look @62811',
      mentions: ['62811@c.us'],
    });
    expect(errors).toHaveLength(0);
  });
});
