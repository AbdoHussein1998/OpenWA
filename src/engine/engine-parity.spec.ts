import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BaileysAdapter } from './adapters/baileys.adapter';
import { WhatsAppWebJsAdapter } from './adapters/whatsapp-web-js.adapter';
import { ENGINE_CAPABILITY_MATRIX } from './engine-capability-matrix';

/**
 * Drift invariants for the engine capability matrix. Status and throw behaviour must agree exactly:
 * a cell is `not-available` if and only if the adapter method throws
 * EngineNotSupportedError/ChannelMediaNotSupportedError.
 *
 * The reverse direction — `not-available` implies throws — is the one that catches a "phantom
 * support" stub: an adapter method that returns null/[] for a capability it cannot deliver, so a
 * caller reads an empty result as an answer instead of the 501 it should get. Those stubs are what
 * docs/29-engine-capability-matrix.md's "0 phantom-support rows" asserts, and until this direction
 * was checked, that claim was true only by inspection — a cell could be marked `not-available`,
 * quietly stop throwing, and nothing would go red.
 *
 * Both directions now trip on any change, forcing a deliberate matrix update.
 *
 * No engine is instantiated and no Chromium/socket is opened: it reads method bodies via
 * `Class.prototype.method.toString()`, a fast hermetic structural check.
 */
const UNSUPPORTED_RE = /this\.unsupported\(|EngineNotSupportedError|ChannelMediaNotSupportedError/;

/** A member declaration, optional or not. `\??` is load-bearing — see the test below. */
const MEMBER_RE = /^\s{2}([a-zA-Z][a-zA-Z0-9]*)\??\s*\(/;

function readInterfaceMethods(): string[] {
  const src = readFileSync(join(__dirname, 'interfaces', 'whatsapp-engine.interface.ts'), 'utf8');
  const names = new Set<string>();
  for (const line of src.split('\n')) {
    const match = line.match(MEMBER_RE);
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

describe('the interface reader sees every member', () => {
  // An optional member is still a member. Before `\??` was added, `probeLiveness?()` did not match
  // here, so the matrix could omit it and this whole file reported green while doing so — every
  // optional method added to IWhatsAppEngine would have had a permanent free pass.
  it('matches an optional declaration as well as a required one', () => {
    expect('  probeLiveness?(): Promise<boolean>;'.match(MEMBER_RE)?.[1]).toBe('probeLiveness');
    expect('  getStatus(): SessionStatus;'.match(MEMBER_RE)?.[1]).toBe('getStatus');
    // And still rejects what it should: a nested member, and a property that is not a call.
    expect('    nested(): void;'.match(MEMBER_RE)).toBeNull();
    expect('  someProperty: string;'.match(MEMBER_RE)).toBeNull();
  });
});

type AdapterCtor = { prototype: Record<string, unknown> };
type AdapterKey = 'wwjs' | 'baileys';
const ADAPTERS: ReadonlyArray<[AdapterKey, AdapterCtor]> = [
  ['wwjs', WhatsAppWebJsAdapter as unknown as AdapterCtor],
  ['baileys', BaileysAdapter as unknown as AdapterCtor],
];

/**
 * Unsupported-throws that live in DELEGATE modules rather than in the adapter prototype.
 *
 * The prototype scan reads a method's own body text, so once an adapter method forwards to a
 * delegate its `EngineNotSupportedError` becomes invisible and BOTH invariants stop applying to it:
 * a genuinely unsupported method could be marked `supported` and the gate would say nothing. That is
 * not hypothetical — every wwjs unsupported-throw except a handful now lives in a `wwebjs-*` module.
 *
 * Every throw site names its own method as a string literal, so the registry is derived from those
 * literals instead of by following delegation, which would mean resolving call graphs in a spec.
 * Bucketed by filename because that is what identifies the engine: `baileys*` is Baileys, the wwjs
 * adapter and its `wwebjs-*` delegates are wwjs.
 */
function readDelegateThrows(): Record<string, Set<string>> {
  const dir = join(__dirname, 'adapters');
  const registry: Record<string, Set<string>> = { wwjs: new Set(), baileys: new Set() };
  for (const file of adapterFiles()) {
    const src = readFileSync(join(dir, file), 'utf8');
    for (const m of src.matchAll(/(?:new EngineNotSupportedError|this\.unsupported)\(\s*'([a-zA-Z][a-zA-Z0-9]*)'/g)) {
      for (const engine of enginesForFile(file)) registry[engine].add(m[1]);
    }
  }
  return registry;
}

/** Adapter modules, spec files excluded — the same set both the scan and its guard below read. */
function adapterFiles(): string[] {
  return readdirSync(join(__dirname, 'adapters')).filter(f => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
}

/** The engine a filename names, or undefined when it carries no engine prefix at all. */
function prefixEngine(file: string): AdapterKey | undefined {
  if (file.startsWith('baileys')) return 'baileys';
  if (file.startsWith('wwebjs-') || file.startsWith('whatsapp-web-js')) return 'wwjs';
  return undefined;
}

/**
 * Adapter modules whose filename names no engine, mapped to the engines that actually import them.
 * Read off the import graph, not the name: safe-link-preview.ts is reached only from
 * baileys-messaging.ts, so the `else wwjs` default this replaces already credited it to the wrong
 * engine, and inbound-media-cap/message-mapper/vcard are reached from both.
 *
 * None of these files throws today, so the registry is byte-identical either way. The list exists
 * for the DIRECTION the old default failed in: a misattributed throw does not merely go unseen, it
 * makes `liveThrows` report false for the engine that really refuses, and the invariant below then
 * demands the matrix mark that cell `supported` to stay green. A file added here without an
 * engine — or added to `adapters/` under no prefix at all — is a red test naming itself instead.
 */
const UNPREFIXED_FILE_ENGINES: Record<string, readonly AdapterKey[]> = {
  'chromium-profile-hygiene.ts': ['wwjs'],
  'inbound-media-cap.ts': ['wwjs', 'baileys'],
  'message-mapper.ts': ['wwjs', 'baileys'],
  'safe-link-preview.ts': ['baileys'],
  'vcard.ts': ['wwjs', 'baileys'],
};

function enginesForFile(file: string): readonly AdapterKey[] {
  const prefix = prefixEngine(file);
  return prefix ? [prefix] : (UNPREFIXED_FILE_ENGINES[file] ?? []);
}

const DELEGATE_THROWS = readDelegateThrows();
const UNPREFIXED_FILES = adapterFiles().filter(f => prefixEngine(f) === undefined);

function liveThrows(adapter: AdapterCtor, method: string, engine: string): boolean {
  if (DELEGATE_THROWS[engine].has(method)) return true;
  const fn = adapter.prototype[method];
  if (typeof fn !== 'function') return true; // missing method = effectively unavailable
  return UNSUPPORTED_RE.test(String(fn));
}

describe('engine capability matrix — drift invariants', () => {
  const methods = readInterfaceMethods();
  const matrixKeys = Object.keys(ENGINE_CAPABILITY_MATRIX).sort();

  // Guard against a pattern that silently stops matching: an empty registry would make the widened
  // scan collapse back to the prototype-only one without a single test turning red.
  it('the delegate throw registry actually found the delegated throws', () => {
    expect(DELEGATE_THROWS.wwjs.size).toBeGreaterThanOrEqual(5);
    // Known-positive: getCatalog's throw lives in wwebjs-catalog.ts, not in the adapter prototype.
    expect(DELEGATE_THROWS.wwjs.has('getCatalog')).toBe(true);
    // Indexed rather than dotted so the unbound-method rule does not fire: this reads the body TEXT,
    // it never calls the method.
    const body = String((WhatsAppWebJsAdapter.prototype as unknown as Record<string, unknown>)['getCatalog']);
    expect(body).not.toMatch(UNSUPPORTED_RE);
  });

  // Guard the guard, in both directions. The right-hand side is the five files that carry no engine
  // prefix today, so a scan that stopped seeing the directory would report an empty left side and
  // fail here rather than pass vacuously. A NEW unprefixed adapter file appears on the left and names
  // itself — attribute it in UNPREFIXED_FILE_ENGINES or give it an engine prefix — and an entry left
  // behind by a rename or deletion is caught the same way from the other side.
  it('every adapter file is attributed to an engine', () => {
    expect([...UNPREFIXED_FILES].sort()).toEqual(Object.keys(UNPREFIXED_FILE_ENGINES).sort());
  });

  it('matrix keys exactly match the interface methods (no missing, no stale)', () => {
    const missing = methods.filter(m => !(m in ENGINE_CAPABILITY_MATRIX));
    const stale = matrixKeys.filter(k => !methods.includes(k));
    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });

  it.each(methods)('%s: throws ⇔ not-available', method => {
    const entry = ENGINE_CAPABILITY_MATRIX[method];
    for (const [adapter, ctor] of ADAPTERS) {
      const throws = liveThrows(ctor, method, adapter);
      const status = entry[adapter].status;
      // A `not-available` cell that does not throw is a phantom stub: the caller gets an empty
      // answer where the contract promises a 501.
      expect({ method, adapter, throws }).toEqual({ method, adapter, throws: status === 'not-available' });
    }
  });
});
