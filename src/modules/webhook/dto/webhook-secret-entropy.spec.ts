import { validate } from 'class-validator';
import { CreateWebhookDto } from './webhook.dto';

/**
 * the HMAC secret signs every delivery this webhook fires. A short secret is recoverable
 * from one observed signature, which turns the signature from an integrity check into a forging
 * tool — 16 characters is the floor, not a recommendation.
 */
describe('CreateWebhookDto secret entropy', () => {
  const dtoWithSecret = (secret: string) => {
    const dto = new CreateWebhookDto();
    dto.url = 'https://receiver.example.com/hook';
    dto.events = ['message.received'];
    dto.secret = secret;
    return dto;
  };

  it('rejects a secret shorter than 16 characters', async () => {
    const errors = await validate(dtoWithSecret('short'));
    expect(errors.some(e => e.property === 'secret')).toBe(true);
  });

  it('accepts a 16+ character secret', async () => {
    const errors = await validate(dtoWithSecret('a-fully-entropic-secret'));
    expect(errors.some(e => e.property === 'secret')).toBe(false);
  });

  it('still allows omitting the secret entirely (unsigned webhooks are a valid choice)', async () => {
    const dto = new CreateWebhookDto();
    dto.url = 'https://receiver.example.com/hook';
    dto.events = ['message.received'];
    expect(errorsOf(await validate(dto))).toBe(0);
    function errorsOf(errs: { property: string }[]): number {
      return errs.filter(e => e.property === 'secret').length;
    }
  });
});
