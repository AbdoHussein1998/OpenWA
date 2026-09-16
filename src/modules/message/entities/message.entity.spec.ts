import { getMetadataArgsStorage } from 'typeorm';

import { Message, bigintToNumberTransformer } from './message.entity';
import { MessageBatch } from './message-batch.entity';
import { StatusUpdate } from '../../status-store/entities/status-update.entity';
import { Session } from '../../session/entities/session.entity';

// bigint columns read back as a string on PostgreSQL but a number on SQLite; the transformer
// normalizes reads so the REST/SDK/MCP contract (always `number`) holds on both dialects.
describe('bigintToNumberTransformer (message.timestamp)', () => {
  it('coerces a PostgreSQL bigint string read to a number', () => {
    // ValueTransformer.from is typed `any`, so assert inline rather than binding to an `any` local.
    expect(bigintToNumberTransformer.from('1700000000')).toBe(1700000000);
    expect(typeof bigintToNumberTransformer.from('1700000000')).toBe('number');
  });

  it('passes a SQLite numeric read through unchanged', () => {
    expect(bigintToNumberTransformer.from(1700000000)).toBe(1700000000);
  });

  it('preserves null', () => {
    expect(bigintToNumberTransformer.from(null)).toBeNull();
  });

  it('writes values through unchanged', () => {
    expect(bigintToNumberTransformer.to(1700000000)).toBe(1700000000);
    expect(bigintToNumberTransformer.to(null)).toBeNull();
  });

  it('coerces a non-numeric read to null rather than leaking NaN (defensive)', () => {
    // A bigint column cannot actually return this; the guard keeps NaN out of the number contract.
    expect(bigintToNumberTransformer.from('not-a-number')).toBeNull();
  });
});

describe('Session-owned entity relations', () => {
  const cases: ReadonlyArray<[Function, string]> = [
    [Message, 'sessionId'],
    [MessageBatch, 'session_id'],
    [StatusUpdate, 'sessionId'],
  ];

  it('maps every Session-owned entity as a required cascading many-to-one relation', () => {
    for (const [target, joinColumnName] of cases) {
      const relation = getMetadataArgsStorage().relations.find(
        candidate => candidate.target === target && candidate.propertyName === 'session',
      );

      expect(relation).toBeDefined();
      expect(relation?.relationType).toBe('many-to-one');
      expect(relation?.options.nullable).toBe(false);
      expect(relation?.options.onDelete).toBe('CASCADE');
      expect(relation?.type()).toBe(Session);

      const joinColumn = getMetadataArgsStorage().joinColumns.find(
        candidate => candidate.target === target && candidate.propertyName === 'session',
      );

      expect(joinColumn?.name).toBe(joinColumnName);
    }
  });
});
