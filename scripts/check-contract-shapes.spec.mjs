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
import { parseHandTypes, parseObjectToken, schemaToken, comparePair, handToken } from './check-contract-shapes.mjs';

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
