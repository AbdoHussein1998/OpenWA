import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BaileysAdapter } from './adapters/baileys.adapter';
import { WhatsAppWebJsAdapter } from './adapters/whatsapp-web-js.adapter';
import { CURATED_CAPABILITY_EXCEPTIONS, engineCapabilityMatrix } from './engine-capability-matrix';

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
const THROW_SITE_RE = /(?:new EngineNotSupportedError|this\.unsupported)\(\s*'([a-zA-Z][a-zA-Z0-9]*)'/;

function readDelegateThrows(): Record<string, Set<string>> {
  const registry: Record<string, Set<string>> = { wwjs: new Set(), baileys: new Set() };
  for (const file of adapterFiles()) {
    for (const method of throwsIn(file)) {
      for (const engine of enginesForFile(file)) registry[engine].add(method);
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
 * Adapter modules whose filename names no engine, read off the import graph rather than the name.
 * `safe-link-preview.ts` is reached only from baileys-messaging.ts, so the `else wwjs` default this
 * replaces already credited it to the wrong engine; `chromium-profile-hygiene.ts` is reached only
 * from the wwjs adapter, so for that one the old default happened to be right.
 *
 * `'shared'` marks a module BOTH adapters import. It is not an attribution — it is the statement
 * that no correct attribution exists. Crediting such a file to both engines would make the invariant
 * demand `not-available` on the engine that never refuses; crediting it to neither would make the
 * invariant demand `supported` on the engine that does. Both directions press a false cell into the
 * matrix, which is the failure this whole scan exists to prevent, so a throw in a shared module is
 * refused outright by `shared modules carry no unsupported-throw` below.
 *
 * None of these files throws today, so the registry is byte-identical to the prefix-only scan.
 */
const SHARED = 'shared' as const;
const UNPREFIXED_FILE_ENGINES: Record<string, readonly AdapterKey[] | typeof SHARED> = {
  'chromium-profile-hygiene.ts': ['wwjs'],
  'inbound-media-cap.ts': SHARED,
  'message-mapper.ts': SHARED,
  'safe-link-preview.ts': ['baileys'],
  'vcard.ts': SHARED,
};

function enginesForFile(file: string): readonly AdapterKey[] {
  const prefix = prefixEngine(file);
  if (prefix) return [prefix];
  const declared = UNPREFIXED_FILE_ENGINES[file];
  return declared === undefined || declared === SHARED ? [] : declared;
}

/** Modules both adapters import, where a refusal cannot be attributed to one engine. */
const SHARED_FILES = Object.entries(UNPREFIXED_FILE_ENGINES)
  .filter(([, engines]) => engines === SHARED)
  .map(([file]) => file);

/** Method names an adapter file refuses by literal, in file order. */
function throwsIn(file: string): string[] {
  const src = readFileSync(join(__dirname, 'adapters', file), 'utf8');
  // A fresh regex per call: THROW_SITE_RE carries /g, and a shared /g regex keeps lastIndex between
  // calls, so reusing the instance would silently skip matches on every other file.
  return [...src.matchAll(new RegExp(THROW_SITE_RE.source, 'g'))].map(m => m[1]);
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
  const matrix = engineCapabilityMatrix();
  const matrixKeys = Object.keys(matrix).sort();

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

  // The other half of the same problem. Attribution fixes files the prefix rule could not name; this
  // fixes files that CANNOT be named, because both adapters import them. There is no safe default:
  // credit a shared module's refusal to both engines and the invariant demands `not-available` from
  // the engine that never refuses; credit it to neither and it demands `supported` from the engine
  // that does. Either way a false cell gets pressed into the matrix — the exact outcome this scan
  // exists to prevent — so the throw is refused where it stands, with the fix named.
  it('shared modules carry no unsupported-throw', () => {
    expect(SHARED_FILES.length).toBeGreaterThanOrEqual(3); // non-vacuous: the shared set was read
    const offenders = SHARED_FILES.filter(file => throwsIn(file).length > 0);
    // Fix: move the throw into that engine's own delegate (`baileys-*.ts` / `wwebjs-*.ts`) and call
    // the shared helper from there, so the refusal carries an engine and this scan can see it.
    expect(offenders).toEqual([]);
  });

  // The matrix is a DERIVED value: engine-capability-matrix.ts walks this same interface file with
  // its own copy of MEMBER_RE and merges the curated exceptions on top. This check is therefore the
  // binding between the two readers — if the module's copy drifted from the spec's, the derived
  // keys and the inventory read here would disagree and this test would fail.
  it('matrix keys exactly match the interface methods (no missing, no stale)', () => {
    const missing = methods.filter(m => !(m in matrix));
    const stale = matrixKeys.filter(k => !methods.includes(k));
    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });

  // The derivation reads an exception only for a name found on the interface, so a curated entry
  // whose method was renamed or removed would otherwise vanish without a signal — exactly the
  // silent drop this fence exists to prevent: the row's rootCause/evidence knowledge must be
  // re-homed deliberately, not lost.
  it('curated exceptions name interface methods (no stale curation)', () => {
    const curated = Object.keys(CURATED_CAPABILITY_EXCEPTIONS);
    // Non-vacuous: an emptied table passes the filter below trivially, while every not-available
    // cell would quietly become the supported/supported default.
    expect(curated.length).toBeGreaterThan(0);
    expect(curated.filter(k => !methods.includes(k))).toEqual([]);
  });

  it.each(methods)('%s: throws ⇔ not-available', method => {
    const entry = matrix[method];
    for (const [adapter, ctor] of ADAPTERS) {
      const throws = liveThrows(ctor, method, adapter);
      const status = entry[adapter].status;
      // A `not-available` cell that does not throw is a phantom stub: the caller gets an empty
      // answer where the contract promises a 501.
      expect({ method, adapter, throws }).toEqual({ method, adapter, throws: status === 'not-available' });
    }
  });
});
