import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { inspectWwebjsRuntime } from './wwebjs-runtime-compat';

describe('inspectWwebjsRuntime', () => {
  const roots: string[] = [];
  const fixture = (client: string, message: string): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-runtime-compat-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'src', 'structures'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.34.8"}');
    fs.writeFileSync(path.join(root, 'src', 'Client.js'), client);
    fs.writeFileSync(path.join(root, 'src', 'structures', 'Message.js'), message);
    return root;
  };
  afterAll(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));

  it('reports stock-style 1.34.8 with upstream ID normalization and no local eventsAttached patch', () => {
    const result = inspectWwebjsRuntime(fixture(
      'async attachEventListeners() { /* upstream */ }',
      'this.id = Base._normalizeId(data.id);',
    ));
    expect(result).toEqual({
      version: '1.34.8',
      messageIdNormalization: 'present',
      localEventsAttachedPatch: 'absent',
      attachEventListenersMethod: 'present',
    });
  });

  it('distinguishes missing bridge method from verified installation', () => {
    const result = inspectWwebjsRuntime(fixture('class Client {}', 'this.id = data.id;'));
    expect(result.attachEventListenersMethod).toBe('missing');
    expect(result.messageIdNormalization).toBe('missing');
  });

  it('reports unknown for unreadable installed sources', () => {
    expect(inspectWwebjsRuntime(path.join(os.tmpdir(), 'unknown-wwjs-src-abc'))).toEqual({
      version: 'unknown',
      messageIdNormalization: 'unknown',
      localEventsAttachedPatch: 'unknown',
      attachEventListenersMethod: 'unknown',
    });
  });
});
