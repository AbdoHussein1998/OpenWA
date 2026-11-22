import { BrowserManager } from './browser.manager';
import { BraveBrowser } from './implementations/brave.browser';
import { isBrowserType, SUPPORTED_BROWSER_TYPES } from './browser.types';

describe('BrowserManager (Phase 1)', () => {
  it('selects the registered Brave driver without launching a browser', () => {
    const manager = new BrowserManager();
    const driver = manager.getBrowser('brave');
    expect(driver).toBeInstanceOf(BraveBrowser);
    expect(driver.type).toBe('brave');
    expect(manager.getBrowser('brave')).toBe(driver);
  });

  it('rejects unknown browser types at runtime instead of falling back', () => {
    const manager = new BrowserManager();
    expect(isBrowserType('chrome')).toBe(false);
    expect(isBrowserType('brave')).toBe(true);
    expect(isBrowserType(null)).toBe(false);
    expect(SUPPORTED_BROWSER_TYPES).toEqual(['brave']);
    expect(() => manager.getBrowser('chrome' as 'brave')).toThrow("Browser 'chrome' is not registered");
  });
});
