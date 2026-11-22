import {
  isSessionOwnedBrowserRoot,
  planOwnedBrowserTree,
  type BrowserExecutableMatcher,
} from './browser-process-identity';
import { BraveBrowser } from './implementations/brave.browser';

const brave = new BraveBrowser();
const chrome: BrowserExecutableMatcher = {
  type: 'chrome',
  matchesExecutable: (commandLine) => /(?:^|[\\/])chrome(?:\.exe)?(?="|$|\s)/i.test(commandLine.split(/\s--/)[0]),
};
const profile = '/data/brave-profiles/account-a';
const owner = `--al-hakim-session=account-a --al-hakim-lease=00000000-0000-4000-8000-000000000001 --user-data-dir=${profile}`;

describe('browser-neutral process identity (phase 2)', () => {
  it('accepts the legacy Brave root and a new recognized Chrome root', () => {
    expect(isSessionOwnedBrowserRoot(`/usr/bin/brave ${owner}`, 'account-a', profile, [brave, chrome], false)).toBe(true);
    expect(isSessionOwnedBrowserRoot(`/usr/bin/chrome ${owner}`, 'account-a', profile, [brave, chrome], false)).toBe(true);
  });

  it('rejects unknown executables even with valid session and profile markers', () => {
    expect(isSessionOwnedBrowserRoot(`/usr/bin/unknown-browser ${owner}`, 'account-a', profile, [brave, chrome], false))
      .toBe(false);
  });

  it('fails on an exact-session or profile mismatch', () => {
    expect(isSessionOwnedBrowserRoot(`/usr/bin/chrome ${owner}`, 'account', profile, [brave, chrome], false)).toBe(false);
    expect(isSessionOwnedBrowserRoot(`/usr/bin/chrome ${owner}`, 'account-a', '/data/brave-profiles/other', [brave, chrome], false)).toBe(false);
  });

  it('preserves Windows quoted user-data-dir handling', () => {
    const command = '"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" ' +
      '--al-hakim-session=account-a --user-data-dir="C:\\Data Files\\brave-profiles\\account-a"';
    expect(isSessionOwnedBrowserRoot(command, 'account-a', 'C:\\Data Files\\brave-profiles\\account-a', [brave], true)).toBe(true);
  });

  it('plans a recognized browser tree leaves-first without touching other sessions', () => {
    const records = [
      { pid: 300, parentPid: 1, commandLine: `/usr/bin/chrome ${owner}` },
      { pid: 301, parentPid: 300, commandLine: '/usr/bin/chrome --type=renderer' },
      { pid: 401, parentPid: 1, commandLine: `/usr/bin/brave --al-hakim-session=other --user-data-dir=/tmp/other` },
    ];
    expect(planOwnedBrowserTree(records, 300, 'account-a', profile, [brave, chrome], false).map(x => x.pid))
      .toEqual([301, 300]);
  });

  it('rejects a process tree with a different session marker and a duplicate PID', () => {
    const root = { pid: 300, parentPid: 1, commandLine: `/usr/bin/chrome ${owner}` };
    expect(() => planOwnedBrowserTree([root, {
      pid: 301, parentPid: 300, commandLine: '/usr/bin/chrome --al-hakim-session=other',
    }], 300, 'account-a', profile, [brave, chrome], false)).toThrow(/different session/);
    expect(() => planOwnedBrowserTree([root, root], 300, 'account-a', profile, [brave, chrome], false))
      .toThrow(/duplicate PID/);
  });
});
