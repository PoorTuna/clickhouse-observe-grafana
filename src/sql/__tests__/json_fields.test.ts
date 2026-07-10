/**
 * Unit tests for native ClickHouse JSON-column field support:
 * - inferFieldType recognizes the JSON type (and its legacy Object('json') spelling).
 * - buildJsonPathsQuery mirrors buildMapKeysQuery's time-bounding/degradation shape.
 * - buildFieldIndex + resolveField correctly resolve JSON paths by name and by sqlExpr passthrough.
 */

import { inferFieldType, FieldModel } from '../fieldModel';
import { buildJsonPathsQuery } from '../introspection';
import { buildFieldIndex, resolveField } from '../fields';
import { OTEL_COLUMN_MAPPING, SourceConfig } from '../../types';

const config: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'otel_logs',
  tracesTable: 'otel_traces',
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
  it('bounds the scan by timestamp when a timestamp column is mapped', () => {
    const sqlStr = buildJsonPathsQuery(config, 'Payload');
    expect(sqlStr).toContain('$__fromTime');
    expect(sqlStr).toContain('$__toTime');
    expect(sqlStr).toContain('JSONAllPathsWithTypes(Payload)');
    expect(sqlStr).toContain('LIMIT 1000');
  });

  it('defaults to a 1000-row limit and matches HyperDX\'s execution guardrails', () => {
    const sqlStr = buildJsonPathsQuery(config, 'Payload');
    expect(sqlStr).toContain('LIMIT 1000');
    expect(sqlStr).toContain('max_execution_time = 15');
    expect(sqlStr).toContain("timeout_overflow_mode = 'break'");
    expect(sqlStr).toContain('max_rows_to_read = 3000000');
    expect(sqlStr).toContain("read_overflow_mode = 'break'");
  });

  it('degrades to an unbounded scan when no timestamp column is mapped', () => {
    const noTsConfig: SourceConfig = { ...config, columns: { ...config.columns, timestamp: '' } };
    const sqlStr = buildJsonPathsQuery(noTsConfig, 'Payload');
    expect(sqlStr).not.toContain('$__fromTime');
    expect(sqlStr).toContain('JSONAllPathsWithTypes(Payload)');
  });

  it('respects a custom limit and table', () => {
    const sqlStr = buildJsonPathsQuery(config, 'Payload', 50, 'custom_table');
    expect(sqlStr).toContain('LIMIT 50');
    expect(sqlStr).toContain('"default"."custom_table"');
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
