/**
 * Unit tests for groupAttributes() — flattens Map/JSON attribute-container columns into dotted-
 * path rows for the detail drawer. Since the "auto-detect Map columns" change, `mapColumns` is a
 * discovered-column Set (mirrors `jsonColumns`) rather than being driven by the 3 now-removed
 * "Resource/Log/Scope Attributes" config fields — tests pass the Set explicitly per case.
 */

import { groupAttributes } from '../schema';
import { ColumnMapping, OTEL_COLUMN_MAPPING } from '../../types';

const columns: ColumnMapping = { ...OTEL_COLUMN_MAPPING };

describe('groupAttributes — Map columns', () => {
  it('flattens a Map column to one row per key with bracket-accessor sqlExpr', () => {
    const row = {
      LogAttributes: { 'http.method': 'GET', 'http.status': '200' },
    };
    const groups = groupAttributes(row, columns, new Set(['LogAttributes']));
    const log = groups.find((g) => g.col === 'LogAttributes')!;
    expect(log.rows).toEqual(
      expect.arrayContaining([
        { key: 'http.method', value: 'GET', sqlExpr: "LogAttributes['http.method']" },
        { key: 'http.status', value: '200', sqlExpr: "LogAttributes['http.status']" },
      ])
    );
  });

  it('treats a Map column as Map even if a value is a nested object', () => {
    const row = { LogAttributes: { user: { id: '42' } } };
    const groups = groupAttributes(row, columns, new Set(['LogAttributes']));
    const log = groups.find((g) => g.col === 'LogAttributes')!;
    // Map values are stringified, not recursed into — that's JSON's job (see below).
    expect(log.rows).toEqual([
      { key: 'user', value: '{"id":"42"}', sqlExpr: "LogAttributes['user']" },
    ]);
  });

  it('omits a column with no attributes', () => {
    const groups = groupAttributes({ LogAttributes: {} }, columns, new Set(['LogAttributes']));
    expect(groups.find((g) => g.col === 'LogAttributes')).toBeUndefined();
  });

  it('flattens multiple discovered Map columns independently, not just a fixed 3-slot list', () => {
    const row = {
      LogAttributes: { 'http.method': 'GET' },
      SomeOtherMapCol: { foo: 'bar' },
    };
    const groups = groupAttributes(row, columns, new Set(['LogAttributes', 'SomeOtherMapCol']));
    expect(groups.map((g) => g.col).sort()).toEqual(['LogAttributes', 'SomeOtherMapCol']);
  });

  // Item 6 (perf plan): groupAttributes must use the same quoteString()-based escaping as
  // discovery / rowFields.ts's deriveAttributeFields, not a raw-spliced `['${key}']` — a Map key
  // containing a quote used to produce a different (and broken) sqlExpr here than everywhere else.
  it('escapes a Map key containing a single quote via quoteString, not raw-spliced', () => {
    const row = { LogAttributes: { "it's": 'x' } };
    const groups = groupAttributes(row, columns, new Set(['LogAttributes']));
    const log = groups.find((g) => g.col === 'LogAttributes')!;
    expect(log.rows).toEqual([
      { key: "it's", value: 'x', sqlExpr: "LogAttributes['it\\'s']" },
    ]);
  });
});

describe('groupAttributes — JSON columns (jsonColumns provided)', () => {
  const jsonColumns = new Set(['LogAttributes']);

  it('recursively flattens nested JSON into dotted-path rows with dot-accessor sqlExpr', () => {
    const row = {
      LogAttributes: { user: { id: '42', name: 'bob' }, http: { method: 'GET' } },
    };
    const groups = groupAttributes(row, columns, new Set(), jsonColumns);
    const log = groups.find((g) => g.col === 'LogAttributes')!;
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
    const groups = groupAttributes(row, columns, new Set(), jsonColumns);
    const log = groups.find((g) => g.col === 'LogAttributes')!;
    expect(log.rows).toEqual([{ key: 'user.id', value: '7', sqlExpr: 'LogAttributes.user.id' }]);
  });

  it('treats an array leaf as a single stringified value, not recursing into it', () => {
    const row = { LogAttributes: { tags: ['a', 'b'] } };
    const groups = groupAttributes(row, columns, new Set(), jsonColumns);
    const log = groups.find((g) => g.col === 'LogAttributes')!;
    expect(log.rows).toEqual([{ key: 'tags', value: '["a","b"]', sqlExpr: 'LogAttributes.tags' }]);
  });

  it('does not affect a column not present in jsonColumns (mixed Map + JSON schema)', () => {
    const row = {
      LogAttributes: { user: { id: '1' } }, // JSON
      ResourceAttributes: { 'service.name': 'api' }, // still Map
    };
    const groups = groupAttributes(row, columns, new Set(['ResourceAttributes']), jsonColumns);
    const resource = groups.find((g) => g.col === 'ResourceAttributes')!;
    expect(resource.rows).toEqual([
      { key: 'service.name', value: 'api', sqlExpr: "ResourceAttributes['service.name']" },
    ]);
  });

  it('returns no rows for an empty or absent JSON column', () => {
    const groups = groupAttributes({}, columns, new Set(), jsonColumns);
    expect(groups.find((g) => g.col === 'LogAttributes')).toBeUndefined();
  });

  // Item 6 (perf plan): a JSON path segment that isn't a bare identifier must be double-quoted via
  // quoteDottedPath(), same as discovery / rowFields.ts — a raw `${col}.${key}` splice used to
  // silently change meaning for a segment like `user-id` (parses as subtraction).
  it('double-quotes a non-bare-identifier path segment via quoteDottedPath, not raw-spliced', () => {
    const row = { LogAttributes: { 'user-id': '42' } };
    const groups = groupAttributes(row, columns, new Set(), jsonColumns);
    const log = groups.find((g) => g.col === 'LogAttributes')!;
    expect(log.rows).toEqual([
      { key: 'user-id', value: '42', sqlExpr: 'LogAttributes."user-id"' },
    ]);
  });
});

describe('groupAttributes — spanAttributes (still config-driven, shared with Traces)', () => {
  it('folds in columns.spanAttributes when mapped, even outside mapColumns/jsonColumns', () => {
    const row = { SpanAttributes: { 'db.system': 'postgres' } };
    const groups = groupAttributes(row, columns, new Set(), new Set());
    const span = groups.find((g) => g.col === columns.spanAttributes)!;
    expect(span.rows).toEqual([
      { key: 'db.system', value: 'postgres', sqlExpr: "SpanAttributes['db.system']" },
    ]);
  });
});
