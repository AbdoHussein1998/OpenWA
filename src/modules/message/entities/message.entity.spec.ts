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

describe('Session ownership relation metadata', () => {
  it('keeps status updates as a required cascading Session-owned relation', () => {
    const relation = getMetadataArgsStorage().relations.find(
      candidate => candidate.target === StatusUpdate && candidate.propertyName === 'session',
    );

    expect(relation).toBeDefined();
    expect(relation?.relationType).toBe('many-to-one');
    expect(relation?.options.nullable).toBe(false);
    expect(relation?.options.onDelete).toBe('CASCADE');
    expect(relation?.type()).toBe(Session);

    const joinColumn = getMetadataArgsStorage().joinColumns.find(
      candidate => candidate.target === StatusUpdate && candidate.propertyName === 'session',
    );

    expect(joinColumn?.name).toBe('sessionId');
  });

  it('keeps messages and message batches as non-null historical Session provenance, not ownership relations', () => {
    const historicalCases: ReadonlyArray<[Function, string, string]> = [
      [Message, 'sessionId', 'sessionId'],
      [MessageBatch, 'sessionId', 'session_id'],
    ];

    for (const [target, propertyName, physicalColumnName] of historicalCases) {
      const relation = getMetadataArgsStorage().relations.find(
        candidate => candidate.target === target && candidate.propertyName === 'session',
      );
      expect(relation).toBeUndefined();

      const joinColumn = getMetadataArgsStorage().joinColumns.find(
        candidate => candidate.target === target && candidate.propertyName === 'session',
      );
      expect(joinColumn).toBeUndefined();

      const column = getMetadataArgsStorage().columns.find(
        candidate => candidate.target === target && candidate.propertyName === propertyName,
      );
      expect(column).toBeDefined();
      expect(column?.options.nullable).not.toBe(true);
      expect(column?.options.name ?? propertyName).toBe(physicalColumnName);
    }
  });
});
