import { createBrowserLaunchArgs } from './browser-launch-args';

describe('browser launch ownership arguments', () => {
  it('preserves ordinary arguments while injecting exactly one lease and session marker', () => {
    const configured = ['--no-sandbox', '--disable-gpu'];
    const result = createBrowserLaunchArgs('session-a', 'owner-1', configured, ['--disable-features=SomeFeature']);
    expect(result).toEqual([
      '--no-sandbox', '--disable-gpu', '--disable-features=SomeFeature',
      '--al-hakim-session=session-a', '--al-hakim-lease=owner-1',
    ]);
    expect(configured).toEqual(['--no-sandbox', '--disable-gpu']);
  });

  it('removes forged user-configured ownership flags including separate user-data-dir values', () => {
    expect(createBrowserLaunchArgs('session-a', 'real-owner', [
      '--al-hakim-lease=fake', '--al-hakim-session=other',
      '--user-data-dir=/tmp/unsafe', '--user-data-dir', '/tmp/also-unsafe',
      '--no-zygote',
    ], [])).toEqual([
      '--no-zygote', '--al-hakim-session=session-a', '--al-hakim-lease=real-owner',
    ]);
  });

  it('rejects ownership and profile overrides supplied by browser drivers', () => {
    for (const arg of ['--user-data-dir=/tmp/unsafe', '--al-hakim-session=other', '--al-hakim-lease=other']) {
      expect(() => createBrowserLaunchArgs('session-a', 'owner-1', [], [arg])).toThrow(/must not override/);
    }
  });

  it('rejects unsafe session identifiers and absent lease tokens', () => {
    expect(() => createBrowserLaunchArgs('../escape', 'owner', [], [])).toThrow();
    expect(() => createBrowserLaunchArgs('valid', '', [], [])).toThrow();
  });
});
