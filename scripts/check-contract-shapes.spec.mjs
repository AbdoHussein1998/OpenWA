#!/usr/bin/env node
/**
 * Spec for check-contract-shapes.mjs — a gate that cannot fail is worse than no gate, so these
 * cases pin the comparator's failure modes against inline fixtures: field presence both ways,
 * optionality flips, token-level drift (widened union, enum mismatch), and the hand parser's
 * regular cases. The `without a ?` case pins a real regression: the member regex once made its
 * literal-`?` group mandatory, so every required field silently failed to parse and the gate
 * compared against a half-empty hand type.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  comparePair,
  handToken,
  parseGoTypes,
  parseHandTypes,
  parseJavaTypes,
  parseObjectToken,
  parsePythonTypes,
  schemaToken,
} from './check-contract-shapes.mjs';

const handSource = `
export interface Sample {
  id: string;
  name?: string;
  direction: string;
  count: number | null;
}
`;

test('parseHandTypes reads required and optional members (a required field is not silently dropped)', () => {
  const types = parseHandTypes(handSource);
  assert.deepEqual(Object.keys(types.Sample), ['id', 'name', 'direction', 'count']);
  assert.equal(types.Sample.id.optional, false);
  assert.equal(types.Sample.name.optional, true);
});

const schemas = {
  SampleDto: {
    type: 'object',
    required: ['id', 'direction', 'count'],
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      direction: { type: 'string', enum: ['incoming', 'outgoing'] },
      count: { type: 'integer' },
    },
  },
  SameDto: {
    type: 'object',
    required: ['id', 'direction', 'count'],
    properties: {
      id: { type: 'string' },
      direction: { type: 'string', enum: ['incoming', 'outgoing'] },
      count: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    },
  },
};

test('comparePair returns no diffs for a conforming pair', () => {
  const hand = {
    id: { optional: false, token: 'string' },
    direction: { optional: false, token: "'incoming' | 'outgoing'" },
    count: { optional: false, token: 'number | null' },
  };
  assert.deepEqual(comparePair('Same', hand, 'SameDto', schemas.SameDto, schemas), []);
});

test('comparePair flags a field the contract has and the hand lacks, and vice versa', () => {
  const hand = { id: { optional: false, token: 'string' }, extra: { optional: false, token: 'string' } };
  const diffs = comparePair('Sample', hand, 'SampleDto', schemas.SampleDto, schemas);
  assert.ok(diffs.some(d => d.includes('hand has "extra"')));
  assert.ok(
    diffs.some(
      d =>
        d.includes('contract has "name"') ||
        d.includes('contract has "direction"') ||
        d.includes('contract has "count"'),
    ),
  );
});

test('comparePair flags an optionality flip', () => {
  const hand = { id: { optional: true, token: 'string' } };
  const diffs = comparePair('Sample', hand, 'SampleDto', schemas.SampleDto, schemas);
  assert.ok(diffs.some(d => d.includes('"id": hand optional, contract required')));
});

test('comparePair flags a widened union and an enum mismatch at token level', () => {
  const hand = {
    id: { optional: false, token: 'string' },
    direction: { optional: false, token: 'string' },
    count: { optional: false, token: 'number | null' },
  };
  const diffs = comparePair('Sample', hand, 'SampleDto', schemas.SampleDto, schemas);
  assert.ok(diffs.some(d => d.includes('"direction": hand string, contract enum(incoming,outgoing)')));
  assert.ok(diffs.some(d => d.includes('"count": hand number|null, contract number')));
});

test('parseObjectToken splits nested object tokens without losing members', () => {
  const members = parseObjectToken('object(id:string,sub:object(a:number,b?:boolean),tail:string)');
  assert.deepEqual(Object.keys(members), ['id', 'sub', 'tail']);
  assert.equal(members.b?.optional ?? parseObjectToken(members.sub.token).b.optional, true);
});

test('handToken reduces enums, null unions and arrays deterministically', () => {
  const types = {};
  assert.equal(handToken("'b' | 'a'", types), 'enum(a,b)'.replace(',', ','));
  assert.equal(handToken('number | null', types), 'number|null');
  assert.equal(handToken('string[]', types), 'array<string>');
});

test('schemaToken honors the OpenAPI 3.0 sibling nullable flag', () => {
  // Regression: nullable is a sibling flag, not a type member — dropping it turned every honest
  // `string | null` hand type into a false mismatch against a plain `string` schema.
  const nullableSchema = { type: 'string', nullable: true };
  assert.equal(schemaToken(nullableSchema, {}), 'string|null');
  assert.equal(schemaToken({ type: 'string' }, {}), 'string');
  assert.equal(schemaToken({ type: 'integer', nullable: true }, {}), 'number|null');
});

test('parseHandTypes resolves `extends` — inherited fields are not "missing"', () => {
  // Regression: CreatedApiKey extends ApiKey read as a bare { apiKey } shape and could never
  // conform to the schema that actually includes every inherited member.
  const types = parseHandTypes(`
export interface Base {
  id: string;
}
export interface Child extends Base {
  apiKey: string;
}
`);
  assert.deepEqual(Object.keys(types.Child), ['id', 'apiKey']);
});

test('parsePythonTypes: TypedDict totals, NotRequired, aliased Literal enums, inheritance', () => {
  const src = [
    'SessionStatus = Literal[',
    '    "created",',
    '    "ready",',
    ']',
    '',
    'class Base(TypedDict, total=False):',
    '    id: str',
    '',
    'class Session(Base):',
    '    name: str',
    '    status: SessionStatus',
    '    lastError: NotRequired[str | None]',
  ].join('\n');
  const types = parsePythonTypes(src);
  assert.equal(types.Session.id.optional, true, 'inherited total=False member stays optional');
  assert.equal(types.Session.name.optional, false);
  assert.equal(types.Session.status.token, 'enum(created,ready)');
  assert.equal(types.Session.lastError.optional, true);
  assert.equal(types.Session.lastError.token, 'string|null');
});

test('parseGoTypes: omitempty optionality, pointer nullability, const-block enums, required slices', () => {
  const src = [
    'type Kind string',
    '',
    'const (',
    '\tKindOne Kind = "one"',
    '\tKindTwo Kind = "two"',
    ')',
    '',
    'type Sample struct {',
    '\tName    string   `json:"name,omitempty"`',
    '\tKind    Kind     `json:"kind"`',
    '\tItems   []string `json:"items"`',
    '\tManaged *string  `json:"managed"`',
    '}',
  ].join('\n');
  // Member maps key by JSON tag (the wire name), not the Go identifier.
  const s = parseGoTypes([src]).Sample;
  assert.equal(s.name.optional, true);
  assert.equal(s.kind.token, 'enum(one,two)');
  assert.equal(s.kind.optional, false);
  assert.equal(s.items.token, 'array<string>');
  assert.equal(s.items.optional, false, 'bare slice is a REQUIRED array');
  assert.equal(s.managed.optional, false, 'pointer without omitempty is required-nullable');
  assert.equal(s.managed.token, 'string|null');
});

test('parseJavaTypes: javadoc between components must not drop fields', () => {
  const src = 'public record Sample(\n    String id,\n    /** documented */\n    Long count) {}\n';
  const types = parseJavaTypes([src]);
  assert.deepEqual(Object.keys(types.Sample), ['id', 'count']);
  assert.equal(types.Sample.count.token, 'number');
});
