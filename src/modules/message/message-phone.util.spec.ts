import { phoneFromWhatsAppIdentity } from './message-phone.util';

describe('phoneFromWhatsAppIdentity', () => {
  it.each([
    ['15550001111@c.us', '15550001111'],
    ['15550001111@s.whatsapp.net', '15550001111'],
    ['15550001111@hosted', '15550001111'],
    ['15550001111:12@c.us', '15550001111'],
    ['15550001111:12@s.whatsapp.net', '15550001111'],
    ['15550001111:12@hosted', '15550001111'],
    ['15550001111@HOSTED', '15550001111'],
    ['+15550001111', '15550001111'],
    ['15550001111', '15550001111'],
  ])('extracts a real phone from %s', (value, expected) => {
    expect(phoneFromWhatsAppIdentity(value)).toBe(expected);
  });

  it.each([
    '123456789012345@lid',
    '123456789012345@hosted.lid',
    '123456789012345@HOSTED.LID',
    '120363012345678901@g.us',
    'status@broadcast',
    '12345@newsletter',
    '12345@broadcast',
    'not-a-phone@c.us',
    '+15550001111@c.us',
    '',
  ])('does not mistake %s for a phone number', value => {
    expect(phoneFromWhatsAppIdentity(value)).toBeUndefined();
  });
});
