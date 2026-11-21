import * as fs from 'fs';
import * as path from 'path';

/**
 * Runtime inventory; source claims and npm/package.json alone cannot prove applied postinstall
 * patches. Unknown checks are represented explicitly, not mistaken for healthy or broken installs.
 */
export interface WwebjsRuntimeCompatibility {
  version: string;
  messageIdNormalization: 'present' | 'missing' | 'unknown';
  localEventsAttachedPatch: 'present' | 'absent' | 'unknown';
  attachEventListenersMethod: 'present' | 'missing' | 'unknown';
}

export function inspectWwebjsRuntime(packageDir?: string): WwebjsRuntimeCompatibility {
  const result: WwebjsRuntimeCompatibility = {
    version: 'unknown',
    messageIdNormalization: 'unknown',
    localEventsAttachedPatch: 'unknown',
    attachEventListenersMethod: 'unknown',
  };
  let root = packageDir;
  if (!root) {
    try {
      root = path.dirname(require.resolve('whatsapp-web.js/package.json'));
    } catch {
      return result;
    }
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof pkg.version === 'string') result.version = pkg.version;
  } catch { /* no metadata, keep unknown */ }
  try {
    const messageSource = fs.readFileSync(path.join(root, 'src', 'structures', 'Message.js'), 'utf8');
    result.messageIdNormalization = /_normalizeId\(|\.\$1/.test(messageSource) ? 'present' : 'missing';
  } catch { /* bundled or inaccessible */ }
  try {
    const clientSource = fs.readFileSync(path.join(root, 'src', 'Client.js'), 'utf8');
    result.localEventsAttachedPatch = /eventsAttached/.test(clientSource) ? 'present' : 'absent';
    result.attachEventListenersMethod = /(?:^|\n)\s*(?:async\s+)?attachEventListeners\s*\(/.test(clientSource) ? 'present' : 'missing';
  } catch { /* bundled or inaccessible */ }
  return result;
}
