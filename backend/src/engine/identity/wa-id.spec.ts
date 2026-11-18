import {
  chatKind,
  isAddressableParticipant,
  isChannelJid,
  isIndividualWid,
  parseWaId,
  toNeutralJid,
  toParticipantWid,
  userPart,
} from './wa-id';

describe('wa-id', () => {
  describe('userPart', () => {
    it('strips the domain and the device suffix', () => {
      expect(userPart('628111@c.us')).toBe('628111');
      expect(userPart('628111:12@s.whatsapp.net')).toBe('628111');
      expect(userPart('120363-456@g.us')).toBe('120363-456');
    });
  });

  describe('parseWaId', () => {
    it('classifies each dialect, folding @s.whatsapp.net and @c.us into one user kind', () => {
      expect(parseWaId('628111@c.us')).toMatchObject({ kind: 'user', userPart: '628111' });
      expect(parseWaId('628111@s.whatsapp.net')).toMatchObject({ kind: 'user', userPart: '628111' });
      expect(parseWaId('628111:3@s.whatsapp.net')).toMatchObject({ kind: 'user', userPart: '628111', device: '3' });
      expect(parseWaId('120-456@g.us')).toMatchObject({ kind: 'group' });
      expect(parseWaId('111@lid')).toMatchObject({ kind: 'lid', userPart: '111' });
      expect(parseWaId('status@broadcast')).toMatchObject({ kind: 'status' });
      expect(parseWaId('abc@newsletter')).toMatchObject({ kind: 'newsletter' });
      expect(parseWaId('not-a-jid')).toMatchObject({ kind: 'unknown' });
    });

    it('classifies broadcast and lowercases the parsed parts', () => {
      expect(parseWaId('123@broadcast')).toMatchObject({ kind: 'broadcast', userPart: '123' });
      expect(parseWaId('ABC@NEWSLETTER')).toMatchObject({ kind: 'newsletter', userPart: 'abc' });
      expect(parseWaId('AbCd@LID')).toMatchObject({ kind: 'lid', userPart: 'abcd' });
    });
  });

  describe('isChannelJid', () => {
    it('is true only for a @newsletter (channel) JID', () => {
      expect(isChannelJid('120363401234567890@newsletter')).toBe(true);
      expect(isChannelJid('ABC@NEWSLETTER')).toBe(true);
    });

    it('is false for user, group, lid, broadcast and status JIDs (they resolve to a real Chat)', () => {
      expect(isChannelJid('628111@c.us')).toBe(false);
      expect(isChannelJid('628111@s.whatsapp.net')).toBe(false);
      expect(isChannelJid('120-456@g.us')).toBe(false);
      expect(isChannelJid('111@lid')).toBe(false);
      expect(isChannelJid('123@broadcast')).toBe(false);
      expect(isChannelJid('status@broadcast')).toBe(false);
      expect(isChannelJid('not-a-jid')).toBe(false);
    });
  });

  describe('toNeutralJid', () => {
    it('maps @s.whatsapp.net (and device suffixes) to @c.us, idempotent on @c.us', () => {
      expect(toNeutralJid('628111@s.whatsapp.net')).toBe('628111@c.us');
      expect(toNeutralJid('628111:12@s.whatsapp.net')).toBe('628111@c.us');
      expect(toNeutralJid('628111@c.us')).toBe('628111@c.us');
    });

    it('keeps groups as @g.us and passes status / empty through', () => {
      expect(toNeutralJid('120-456@g.us')).toBe('120-456@g.us');
      expect(toNeutralJid('status@broadcast')).toBe('status@broadcast');
      expect(toNeutralJid('')).toBe('');
    });

    it('resolves a lid to <phone>@c.us when the resolver knows it, else keeps the raw lid', () => {
      const resolve = (jid: string) => (jid === '111@lid' ? '628999' : null);
      expect(toNeutralJid('111@lid', resolve)).toBe('628999@c.us');
      expect(toNeutralJid('222@lid', resolve)).toBe('222@lid');
      expect(toNeutralJid('111@lid')).toBe('111@lid');
    });

    it('keeps newsletter and broadcast channels in their own dialect', () => {
      expect(toNeutralJid('120363-abc@newsletter')).toBe('120363-abc@newsletter');
      expect(toNeutralJid('120363-def@broadcast')).toBe('120363-def@broadcast');
    });

    it('passes an unrecognized format through unchanged', () => {
      expect(toNeutralJid('weird-thing')).toBe('weird-thing');
    });
  });

  describe('chatKind', () => {
    it.each([
      ['628111@c.us', 'individual'],
      ['628111@s.whatsapp.net', 'individual'],
      ['628111:12@s.whatsapp.net', 'individual'],
      ['4707@lid', 'individual'],
      ['12036@g.us', 'group'],
      ['abc@newsletter', 'channel'],
      ['status@broadcast', 'status'],
      ['12036@broadcast', 'broadcast'],
      ['not-a-jid', 'unknown'],
      ['', 'unknown'],
    ])('classifies %s as %s', (jid, expected) => {
      expect(chatKind(jid)).toBe(expected);
    });
  });

  describe('isAddressableParticipant', () => {
    it.each([
      ['628123456789', true],
      ['628123456789@c.us', true],
      ['628123456789@s.whatsapp.net', true],
      ['12345678901234567890@lid', true],
      ['628123456789:12@c.us', true],
      ['  628123456789@c.us  ', true],
      ['NOT A USER', false],
      ['', false],
      ['1234', false],
      ['12036@g.us', false],
      ['status@broadcast', false],
      ['abc@newsletter', false],
      ['abc@weird', false],
      ['NOT A USER@c.us', false],
      ['abc@c.us', false],
      ['abc@s.whatsapp.net', false],
      ['abc@lid', false],
      ['@c.us', false],
      ['x y@c.us', false],
      ['0@c.us', false],
      ['-1@c.us', false],
      ['+628123456789@c.us', false],
    ])('classifies %s as %s', (value, expected) => {
      expect(isAddressableParticipant(value)).toBe(expected);
    });
  });

  describe('toParticipantWid', () => {
    it('qualifies a bare number to the c.us dialect', () => {
      expect(toParticipantWid('628123456789')).toBe('628123456789@c.us');
    });

    it('leaves an already-qualified id untouched', () => {
      expect(toParticipantWid('628123456789@c.us')).toBe('628123456789@c.us');
      expect(toParticipantWid('12345678901234567890@lid')).toBe('12345678901234567890@lid');
      expect(toParticipantWid('628123456789@s.whatsapp.net')).toBe('628123456789@s.whatsapp.net');
    });

    it.each([['abc@weird'], ['abc'], ['NOT A USER'], ['']])(
      'leaves %s alone rather than minting a nonsense id from it',
      value => {
        expect(toParticipantWid(value)).toBe(value);
      },
    );
  });

  describe('Meta-hosted dialects', () => {
    it('folds each hosted dialect into the entity it names', () => {
      expect(parseWaId('628111@hosted')).toMatchObject({ kind: 'user', userPart: '628111' });
      expect(parseWaId('4707@hosted.lid')).toMatchObject({ kind: 'lid', userPart: '4707' });
      expect(parseWaId('628111:3@hosted')).toMatchObject({ kind: 'user', userPart: '628111', device: '3' });
      expect(parseWaId('ABC@HOSTED.LID')).toMatchObject({ kind: 'lid', userPart: 'abc' });
    });

    it('does not confuse @hosted.lid with @hosted: the domain is the whole suffix', () => {
      expect(parseWaId('4707@hosted.lid').kind).toBe('lid');
      expect(parseWaId('4707@hosted').kind).toBe('user');
    });

    it('accepts them as individuals, which is what the guards refused before', () => {
      expect(isIndividualWid('628123456789@hosted')).toBe(true);
      expect(isIndividualWid('12345678901234567890@hosted.lid')).toBe(true);
      expect(isAddressableParticipant('628123456789@hosted')).toBe(true);
      expect(isIndividualWid('NOT A USER@hosted')).toBe(false);
      expect(isIndividualWid('1234@hosted.lid')).toBe(false);
    });

    it('normalizes to the neutral dialect of the same account, so history stays in one place', () => {
      expect(toNeutralJid('628111@hosted')).toBe('628111@c.us');
      expect(toNeutralJid('628111:3@hosted')).toBe('628111@c.us');
      expect(toNeutralJid('4707@hosted.lid')).toBe('4707@lid');
      expect(toNeutralJid('4707@hosted.lid', () => '628111')).toBe('628111@c.us');
    });

    it('surfaces as an individual chat, not unknown', () => {
      expect(chatKind('628111@hosted')).toBe('individual');
      expect(chatKind('4707@hosted.lid')).toBe('individual');
    });
  });
});
