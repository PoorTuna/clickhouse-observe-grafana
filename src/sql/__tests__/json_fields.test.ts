/**
 * Unit tests for native ClickHouse JSON-column field support:
 * - inferFieldType recognizes the JSON type (and its legacy Object('json') spelling).
 * - buildJsonPathsQuery stays a *bare* distinctJSONPaths query — the absence assertions below are
 *   the regression guard for ClickHouse's paths-only subcolumn optimization, which is disabled the
 *   moment the query grows a WHERE/PREWHERE/GROUP BY.
 * - parseJsonTypedPaths recovers declared path types from the column's own JSON(...) type.
 * - buildFieldIndex + resolveField correctly resolve JSON paths by name and by sqlExpr passthrough.
 */

import { inferFieldType, parseJsonTypedPaths, FieldModel } from '../fieldModel';
import { buildJsonPathsQuery } from '../introspection';
import { DEFAULT_QUERY_TIMEOUT_SECONDS } from '../settings';
import { buildFieldIndex, resolveField } from '../fields';
import { OTEL_COLUMN_MAPPING, SourceConfig } from '../../types';

const config: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'otel_logs',
  isOtel: true,
  columns: OTEL_COLUMN_MAPPING,
};

describe('inferFieldType — JSON', () => {
  it('recognizes the native JSON type', () => {
    expect(inferFieldType('JSON')).toBe('json');
  });

  it('recognizes JSON with type-hint/config args', () => {
    expect(inferFieldType("JSON(max_dynamic_paths=100)")).toBe('json');
    expect(inferFieldType('JSON(user.id UInt32)')).toBe('json');
  });

  it('recognizes the legacy Object(\'json\') spelling', () => {
    expect(inferFieldType("Object('json')")).toBe('json');
  });

  it('does not misclassify Map or String as json', () => {
    expect(inferFieldType('Map(LowCardinality(String), String)')).toBe('map');
    expect(inferFieldType('String')).toBe('string');
  });
});

describe('buildJsonPathsQuery', () => {
  it('asks for every path in the table via distinctJSONPaths, as one JSON-encoded cell', () => {
    const sqlStr = buildJsonPathsQuery(config, 'Payload', { table: config.logsTable });
    expect(sqlStr).toContain('toJSONString(distinctJSONPaths(Payload))');
    expect(sqlStr).toContain('"default"."otel_logs"');
  });

  it('carries no filter, ordering or bound — the optimization depends on it', () => {
    // ClickHouse's FunctionToSubcolumnsPass refuses to rewrite distinctJSONPaths into the
    // paths-only subcolumn read when the query has WHERE/PREWHERE/GROUP BY, so a "helpful" time
    // predicate here would make this query several times *slower*, not faster. ORDER BY/LIMIT are
    // pointless on a single-row aggregate and would only muddy that contract.
    const sqlStr = buildJsonPathsQuery(config, 'Payload', { table: config.logsTable });
    expect(sqlStr).not.toContain('WHERE');
    expect(sqlStr).not.toContain('PREWHERE');
    expect(sqlStr).not.toContain('GROUP BY');
    expect(sqlStr).not.toContain('ORDER BY');
    expect(sqlStr).not.toContain('LIMIT');
    expect(sqlStr).not.toContain('$__fromTime');
  });

  it('selects nothing but the paths — a companion count() would be wrong', () => {
    // Once the rewrite fires, the special subcolumn yields one row per read block, so a
    // row-counting aggregate in the same query reports block count. Verified on CH 26.3.17.4:
    // count() came back 24 for a 50k-row table with the optimization on.
    const sqlStr = buildJsonPathsQuery(config, 'Payload', { table: config.logsTable });
    expect(sqlStr).not.toContain('count(');
  });

  it('asks for the subcolumn optimization explicitly', () => {
    const sqlStr = buildJsonPathsQuery(config, 'Payload', { table: config.logsTable });
    expect(sqlStr).toContain('optimize_functions_to_subcolumns = 1');
  });

  it('does not send enable_analyzer (unknown setting names fail the whole query on older servers)', () => {
    const sqlStr = buildJsonPathsQuery(config, 'Payload', { table: config.logsTable });
    expect(sqlStr).not.toContain('enable_analyzer');
    expect(sqlStr).not.toContain('allow_experimental_analyzer');
  });

  it('keeps the timeout guardrail (still throws, never a silent truncation)', () => {
    const sqlStr = buildJsonPathsQuery(config, 'Payload', { table: config.logsTable });
    expect(sqlStr).toContain(`max_execution_time = ${DEFAULT_QUERY_TIMEOUT_SECONDS}`);
    expect(sqlStr).toContain("timeout_overflow_mode = 'throw'");
  });

  it('respects a custom table', () => {
    const sqlStr = buildJsonPathsQuery(config, 'Payload', { table: 'custom_table' });
    expect(sqlStr).toContain('"default"."custom_table"');
  });

  it('includes select_sequential_consistency by default', () => {
    const sqlStr = buildJsonPathsQuery(config, 'Payload', { table: config.logsTable });
    expect(sqlStr).toContain('select_sequential_consistency = 1');
  });
});

describe('parseJsonTypedPaths', () => {
  it('returns the declared paths with their types', () => {
    expect(parseJsonTypedPaths('JSON(user.id UInt32, name String)')).toEqual([
      { path: 'user.id', type: 'UInt32' },
      { path: 'name', type: 'String' },
    ]);
  });

  it('keeps a declared type that contains commas intact', () => {
    expect(parseJsonTypedPaths('JSON(amount Decimal(10, 2), tags Array(String))')).toEqual([
      { path: 'amount', type: 'Decimal(10, 2)' },
      { path: 'tags', type: 'Array(String)' },
    ]);
  });

  it('unquotes backticked path names', () => {
    expect(parseJsonTypedPaths('JSON(`odd name` String)')).toEqual([{ path: 'odd name', type: 'String' }]);
  });

  it('skips hints and SKIP clauses', () => {
    expect(
      parseJsonTypedPaths("JSON(a String, max_dynamic_paths=8, max_dynamic_types = 4, SKIP secret, SKIP REGEXP '^tmp')")
    ).toEqual([{ path: 'a', type: 'String' }]);
  });

  it('returns nothing for an untyped or non-JSON column type', () => {
    expect(parseJsonTypedPaths('JSON')).toEqual([]);
    expect(parseJsonTypedPaths("Object('json')")).toEqual([]);
    expect(parseJsonTypedPaths('Map(String, String)')).toEqual([]);
  });
});

describe('buildFieldIndex + resolveField — JSON paths', () => {
  const jsonField: FieldModel = {
    id: 'json:Payload:user.id',
    name: 'user.id',
    displayName: 'user.id',
    sqlExpr: 'Payload.user.id',
    type: 'number',
    source: 'json',
    jsonColumn: 'Payload',
    jsonPath: 'user.id',
  };
  const index = buildFieldIndex([jsonField]);

  it('resolves a JSON path by name to its sqlExpr with kind "json"', () => {
    const resolved = resolveField('user.id', config, index);
    expect(resolved).toEqual({ sqlExpr: 'Payload.user.id', kind: 'json' });
  });

  it('resolves an already-built JSON sqlExpr (sqlExpr passthrough) without re-wrapping it', () => {
    const resolved = resolveField('Payload.user.id', config, index);
    expect(resolved).toEqual({ sqlExpr: 'Payload.user.id', kind: 'json' });
  });

  it('without an index, the same dotted name resolves to null (no Map-lookup guessing)', () => {
    const resolved = resolveField('user.id', config);
    expect(resolved).toBeNull();
  });
});
