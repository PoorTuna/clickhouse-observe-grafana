/**
 * Unit tests for groupAttributes() — covers the Map-vs-JSON attribute column split added to fix
 * the Log Detail Drawer emitting invalid Map-accessor SQL (`col['key']`) for native JSON columns.
 */

import { groupAttributes } from '../schema';
import { ColumnMapping, OTEL_COLUMN_MAPPING } from '../../types';

const columns: ColumnMapping = {
  ...OTEL_COLUMN_MAPPING,
  resourceAttributes: 'ResourceAttributes',
  logAttributes: 'LogAttributes',
};

describe('groupAttributes — Map columns (no jsonColumns arg, back-compat)', () => {
  it('flattens a Map column to one row per key with bracket-accessor sqlExpr', () => {
    const row = {
      LogAttributes: { 'http.method': 'GET', 'http.status': '200' },
    };
    const groups = groupAttributes(row, columns);
    const log = groups.find((g) => g.group === 'log')!;
    expect(log.rows).toEqual(
      expect.arrayContaining([
        { key: 'http.method', value: 'GET', sqlExpr: "LogAttributes['http.method']" },
        { key: 'http.status', value: '200', sqlExpr: "LogAttributes['http.status']" },
      ])
    );
  });

  it('treats every attribute column as Map when jsonColumns is omitted, even if the value is a nested object', () => {
    const row = { LogAttributes: { user: { id: '42' } } };
    const groups = groupAttributes(row, columns);
    const log = groups.find((g) => g.group === 'log')!;
    // Old behavior: top-level key only, nested object stringified — not exploded.
    expect(log.rows).toEqual([
      { key: 'user', value: '{"id":"42"}', sqlExpr: "LogAttributes['user']" },
    ]);
  });

  it('omits a group with no attributes', () => {
    const groups = groupAttributes({ LogAttributes: {} }, columns);
    expect(groups.find((g) => g.group === 'log')).toBeUndefined();
  });
});

describe('groupAttributes — JSON columns (jsonColumns provided)', () => {
  const jsonColumns = new Set(['LogAttributes']);

  it('recursively flattens nested JSON into dotted-path rows with dot-accessor sqlExpr', () => {
    const row = {
      LogAttributes: { user: { id: '42', name: 'bob' }, http: { method: 'GET' } },
    };
    const groups = groupAttributes(row, columns, jsonColumns);
    const log = groups.find((g) => g.group === 'log')!;
    expect(log.rows).toEqual(
      expect.arrayContaining([
        { key: 'user.id', value: '42', sqlExpr: 'LogAttributes.user.id' },
        { key: 'user.name', value: 'bob', sqlExpr: 'LogAttributes.user.name' },
        { key: 'http.method', value: 'GET', sqlExpr: 'LogAttributes.http.method' },
      ])
    );
    expect(log.rows).toHaveLength(3);
  });

  it('parses a JSON column serialized as a string', () => {
    const row = { LogAttributes: JSON.stringify({ user: { id: '7' } }) };
    const groups = groupAttributes(row, columns, jsonColumns);
    const log = groups.find((g) => g.group === 'log')!;
    expect(log.rows).toEqual([{ key: 'user.id', value: '7', sqlExpr: 'LogAttributes.user.id' }]);
  });

  it('treats an array leaf as a single stringified value, not recursing into it', () => {
    const row = { LogAttributes: { tags: ['a', 'b'] } };
    const groups = groupAttributes(row, columns, jsonColumns);
    const log = groups.find((g) => g.group === 'log')!;
    expect(log.rows).toEqual([{ key: 'tags', value: '["a","b"]', sqlExpr: 'LogAttributes.tags' }]);
  });

  it('does not affect a column not present in jsonColumns (mixed Map + JSON schema)', () => {
    const row = {
      LogAttributes: { user: { id: '1' } }, // JSON
      ResourceAttributes: { 'service.name': 'api' }, // still Map
    };
    const groups = groupAttributes(row, columns, jsonColumns);
    const resource = groups.find((g) => g.group === 'resource')!;
    expect(resource.rows).toEqual([
      { key: 'service.name', value: 'api', sqlExpr: "ResourceAttributes['service.name']" },
    ]);
  });

  it('returns no rows for an empty or absent JSON column', () => {
    const groups = groupAttributes({}, columns, jsonColumns);
    expect(groups.find((g) => g.group === 'log')).toBeUndefined();
  });
});
