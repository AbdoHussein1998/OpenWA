import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysContacts, type BaileysContactsHost } from './baileys-contacts';
import { createLogger } from '../../common/services/logger.service';
import type { Contact } from '../interfaces/whatsapp-engine.interface';

/**
 * `toNeutralContact` returned the literal `isBlocked: false` for every contact — not derived from
 * anything — while the SAME session's `/contacts/blocked` endpoint returned the real ids. Automation
 * that skips blocked contacts before sending therefore messaged people the account had explicitly
 * blocked, on the strength of a field the gateway had simply made up.
 */
const logger = createLogger('baileys-contact-blocked.spec');

describe('Baileys contact reads report real blocklist state', () => {
  const contact = (id: string): Contact => ({
    id,
    number: id.split('@')[0],
    isMyContact: true,
    isBlocked: false,
    pushName: 'x',
  });

  function make(opts: { blocklist?: string[]; blocklistError?: Error }): {
    contacts: BaileysContacts;
    warn: jest.Mock;
    fetchBlocklist: jest.Mock;
  } {
    const warn = jest.fn();
    const fetchBlocklist = opts.blocklistError
      ? jest.fn().mockRejectedValue(opts.blocklistError)
      : jest.fn().mockResolvedValue(opts.blocklist ?? []);
    const host = {
      ensureReady: jest.fn(),
      getSocket: () =>
        ({ fetchBlocklist, updateBlockStatus: jest.fn().mockResolvedValue(undefined) }) as unknown as WASocket,
      logger: { ...logger, warn },
      listContacts: () => [contact('628111@c.us'), contact('628222@c.us')],
      findContact: (id: string) => contact(id),
      toNeutralJid: (jid: string) => jid,
    } as unknown as BaileysContactsHost;
    return { contacts: new BaileysContacts(host), warn, fetchBlocklist };
  }

  it('marks a contact on the blocklist as blocked', async () => {
    const { contacts } = make({ blocklist: ['628222@c.us'] });

    const all = await contacts.getContacts();

    expect(all.find(c => c.id === '628222@c.us')?.isBlocked).toBe(true);
    expect(all.find(c => c.id === '628111@c.us')?.isBlocked).toBe(false);
  });

  it('marks a single contact read the same way', async () => {
    const { contacts } = make({ blocklist: ['628222@c.us'] });

    await expect(contacts.getContactById('628222@c.us')).resolves.toMatchObject({ isBlocked: true });
    await expect(contacts.getContactById('628111@c.us')).resolves.toMatchObject({ isBlocked: false });
  });

  // A blocklist query that fails is a transport fact, not a claim that nobody is blocked. The read
  // must not fail outright either — contacts are still useful — so it degrades loudly.
  // Regression guard for a cost this fix introduced: getContactById is called once per unique poster
  // when a session seeds its status history (session-engine-leaf-events resolvePoster), purely to
  // read a NAME. Querying the blocklist on each of those turned one connect into N network
  // round-trips, each with its own deadline. Memoised so a burst shares one query.
  it('issues ONE blocklist query for a burst of reads', async () => {
    const { contacts, fetchBlocklist } = make({ blocklist: [] });

    await contacts.getContactById('628111@c.us');
    await contacts.getContactById('628222@c.us');
    await contacts.getContacts();

    expect(fetchBlocklist).toHaveBeenCalledTimes(1);
  });

  // The memo must not outlive a change made through this same API: block() and unblock() clear it,
  // and without that a contact just blocked still reads isBlocked=false for the memo window.
  it('re-queries after a block, so a just-changed state is not read stale', async () => {
    const { contacts, fetchBlocklist } = make({ blocklist: [] });
    await contacts.getContactById('628111@c.us');
    expect(fetchBlocklist).toHaveBeenCalledTimes(1);

    await contacts.blockContact('628111@c.us');
    await contacts.getContactById('628111@c.us');

    expect(fetchBlocklist).toHaveBeenCalledTimes(2);
  });

  it('re-queries after an unblock for the same reason', async () => {
    const { contacts, fetchBlocklist } = make({ blocklist: ['628111@c.us'] });
    await contacts.getContactById('628111@c.us');
    await contacts.unblockContact('628111@c.us');
    await contacts.getContactById('628111@c.us');

    expect(fetchBlocklist).toHaveBeenCalledTimes(2);
  });

  it('does not fail the contact read when the blocklist query does, and says so', async () => {
    const { contacts, warn } = make({
      blocklistError: new Error('WhatsApp did not answer the blocklist query in time'),
    });

    const all = await contacts.getContacts();

    expect(all).toHaveLength(2);
    expect(warn).toHaveBeenCalled();
  });
});
