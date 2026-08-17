/**
 * Unit tests for native ClickHouse JSON-column field support:
 * - inferFieldType recognizes the JSON type (and its legacy Object('json') spelling).
 * - buildJsonPathsQuery mirrors buildMapKeysQuery's bounded sampled-CTE shape.
 * - buildFieldIndex + resolveField correctly resolve JSON paths by name and by sqlExpr passthrough.
 */

import { inferFieldType, FieldModel } from '../fieldModel';
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
  const conditions = [`${config.columns.timestamp} >= $__fromTime AND ${config.columns.timestamp} <= $__toTime`];

  it('wraps the scan in a sample CTE, ordered by timestamp DESC, bounded by LIMIT', () => {
    const sqlStr = buildJsonPathsQuery(config, 'Payload', { table: config.logsTable, conditions });
    expect(sqlStr).toContain('WITH sample AS');
    expect(sqlStr).toContain(`ORDER BY ${config.columns.timestamp} DESC`);
    expect(sqlStr).toContain('LIMIT 500');
    expect(sqlStr).toContain('JSONAllPathsWithTypes(j)');
  });

  it('scopes the sample by the caller-supplied WHERE conditions (search/filters, not just time)', () => {
    const scoped = [...conditions, `ServiceName = 'checkout'`];
    const sqlStr = buildJsonPathsQuery(config, 'Payload', { table: config.logsTable, conditions: scoped });
    expect(sqlStr).toContain('$__fromTime');
    expect(sqlStr).toContain(`ServiceName = 'checkout'`);
  });

  it('keeps the timeout guardrail (still throws, not a silent truncation) on top of the LIMIT bound', () => {
    const sqlStr = buildJsonPathsQuery(config, 'Payload', { table: config.logsTable, conditions });
    expect(sqlStr).toContain(`max_execution_time = ${DEFAULT_QUERY_TIMEOUT_SECONDS}`);
    expect(sqlStr).toContain("timeout_overflow_mode = 'throw'");
  });

  it('omits ORDER BY (but still applies LIMIT) when no timestamp column is mapped', () => {
    const noTsConfig: SourceConfig = { ...config, columns: { ...config.columns, timestamp: '' } };
    const sqlStr = buildJsonPathsQuery(noTsConfig, 'Payload', { table: config.logsTable, conditions: [] });
    expect(sqlStr).not.toContain('ORDER BY');
    expect(sqlStr).toContain('LIMIT 500');
  });

  it('respects a custom table', () => {
    const sqlStr = buildJsonPathsQuery(config, 'Payload', { table: 'custom_table', conditions });
    expect(sqlStr).toContain('"default"."custom_table"');
  });

  it('respects a custom sampleSize', () => {
    const sqlStr = buildJsonPathsQuery(config, 'Payload', { table: config.logsTable, conditions, sampleSize: 1000 });
    expect(sqlStr).toContain('LIMIT 1000');
  });

  it('includes select_sequential_consistency by default', () => {
    const sqlStr = buildJsonPathsQuery(config, 'Payload', { table: config.logsTable, conditions });
    expect(sqlStr).toContain('select_sequential_consistency = 1');
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
