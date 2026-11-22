import { Injectable } from '@nestjs/common';
import type { BrowserInterface } from './interfaces/browser.interface';
import { BraveBrowser } from './implementations/brave.browser';
import type { BrowserType } from './browser.types';

/**
 * Selects a browser DRIVER, not a running browser process or a session profile.
 *
 * Registry entries are long-lived and stateless; WwebjsLifecycle will continue
 * to create a separate Puppeteer/whatsapp-web.js browser per WhatsApp session.
 *
 * Registered in EngineModule. EngineFactory passes this singleton to the
 * built-in plugin and direct fallback; neither manages a shared live process.
 */
@Injectable()
export class BrowserManager {
  private readonly browsers: ReadonlyMap<BrowserType, BrowserInterface> = new Map([
    ['brave', new BraveBrowser()],
  ]);

  getBrowser(type: BrowserType): BrowserInterface {
    const browser = this.browsers.get(type);
    if (!browser) {
      throw new Error(`Browser '${String(type)}' is not registered`);
    }
    return browser;
  }
}
