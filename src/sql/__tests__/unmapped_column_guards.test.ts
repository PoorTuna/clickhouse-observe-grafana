/**
 * Regression tests for Tier 1 audit items 2-6: query builders that used to interpolate
 * unconditional column references (emitting literal `undefined` into SQL, or a broken
 * time-bound WHERE clause) when the relevant column wasn't mapped. Each should now either
 * degrade gracefully (constant fallback, dropped WHERE clause) or bail out to an empty string
 * when the field the whole query hinges on (traceId, timestamp) is unmapped.
 */

import {
  buildLogsByTraceIdQuery,
  buildSurroundingDocsQuery,
  buildVolumeQuery,
  resolveVolumeBreakdown,
} from '../queryBuilder';
import { buildMapKeysQuery } from '../introspection';
import { FieldModel, selectMapColumns } from '../fieldModel';
import { EMPTY_COLUMN_MAPPING, SourceConfig } from '../../types';

const arbitraryConfig: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'my_table',
  tracesTable: '',
  isOtel: false,
  columns: { ...EMPTY_COLUMN_MAPPING, timestamp: 'ts' },
};

// buildTraceListQuery / buildTraceDetailQuery / buildTraceVolumeQuery guard coverage now lives in
// build_trace_queries.test.ts alongside their other behavior.

describe('buildVolumeQuery', () => {
  it('returns empty string when timestamp is unmapped', () => {
    const cfg: SourceConfig = { ...arbitraryConfig, columns: { ...EMPTY_COLUMN_MAPPING } };
    const sql = buildVolumeQuery(cfg, { search: '', filters: [], rawSql: '', useRawSql: false, limit: 200, columns: [] }, {
      interval: { macro: true },
      breakdown: { kind: 'none' },
    });
    expect(sql).toBe('');
  });
});

describe('buildMapKeysQuery', () => {
  it('omits the time filter (not "undefined") when timestamp is unmapped', () => {
    const cfg: SourceConfig = { ...arbitraryConfig, columns: { ...EMPTY_COLUMN_MAPPING } };
    const sql = buildMapKeysQuery(cfg, 'attrs');
    expect(sql).not.toContain('undefined');
    expect(sql).not.toContain('WHERE');
  });

  it('includes the time filter when timestamp is mapped', () => {
    const sql = buildMapKeysQuery(arbitraryConfig, 'attrs');
    expect(sql).toContain('WHERE ts >= $__fromTime');
  });

  it('defaults to a 1000-row limit and matches HyperDX\'s execution guardrails', () => {
    const sql = buildMapKeysQuery(arbitraryConfig, 'attrs');
    expect(sql).toContain('LIMIT 1000');
    expect(sql).toContain('max_execution_time = 15');
    expect(sql).toContain("timeout_overflow_mode = 'break'");
    expect(sql).toContain('max_rows_to_read = 3000000');
    expect(sql).toContain("read_overflow_mode = 'break'");
  });

  it('still honors an explicit limit override', () => {
    const sql = buildMapKeysQuery(arbitraryConfig, 'attrs', 50);
    expect(sql).toContain('LIMIT 50');
  });
});

describe('selectMapColumns', () => {
  // Regression coverage for Code 43 ILLEGAL_TYPE_OF_ARGUMENT: mapKeys() must not be run against
  // configured attribute columns whose discovered ClickHouse type isn't actually Map(...).
  const col = (name: string, type: FieldModel['type']): FieldModel => ({
    id: `col:${name}`,
    name,
    displayName: name,
    sqlExpr: name,
    type,
    source: 'column',
  });

  it('skips a configured column that is typed String instead of Map', () => {
    const columns = [col('ResourceAttributes', 'string'), col('LogAttributes', 'map')];
    expect(selectMapColumns(['ResourceAttributes', 'LogAttributes'], columns)).toEqual(['LogAttributes']);
  });

  it('skips a configured column that is typed JSON instead of Map', () => {
    const columns = [col('ResourceAttributes', 'json'), col('LogAttributes', 'map')];
    expect(selectMapColumns(['ResourceAttributes', 'LogAttributes'], columns)).toEqual(['LogAttributes']);
  });

  it('keeps columns typed Map', () => {
    const columns = [col('ResourceAttributes', 'map'), col('LogAttributes', 'map'), col('ScopeAttributes', 'map')];
    expect(selectMapColumns(['ResourceAttributes', 'LogAttributes', 'ScopeAttributes'], columns)).toEqual([
      'ResourceAttributes',
      'LogAttributes',
      'ScopeAttributes',
    ]);
  });

  it('drops undefined/empty configured names', () => {
    const columns = [col('LogAttributes', 'map')];
    expect(selectMapColumns([undefined, '', 'LogAttributes'], columns)).toEqual(['LogAttributes']);
  });
});

describe('buildLogsByTraceIdQuery', () => {
  it('returns empty string when traceId is unmapped', () => {
    const cfg: SourceConfig = { ...arbitraryConfig, columns: { ...EMPTY_COLUMN_MAPPING, timestamp: 'ts', body: 'msg' } };
    expect(buildLogsByTraceIdQuery(cfg, 'abc123')).toBe('');
  });

  it('returns empty string when timestamp is unmapped', () => {
    const cfg: SourceConfig = { ...arbitraryConfig, columns: { ...EMPTY_COLUMN_MAPPING, traceId: 'trace_id', body: 'msg' } };
    expect(buildLogsByTraceIdQuery(cfg, 'abc123')).toBe('');
  });

  it('returns empty string when body is unmapped', () => {
    const cfg: SourceConfig = { ...arbitraryConfig, columns: { ...EMPTY_COLUMN_MAPPING, traceId: 'trace_id', timestamp: 'ts' } };
    expect(buildLogsByTraceIdQuery(cfg, 'abc123')).toBe('');
  });

  it('builds a query with no undefined tokens when all required columns are mapped', () => {
    const cfg: SourceConfig = {
      ...arbitraryConfig,
      columns: { ...EMPTY_COLUMN_MAPPING, traceId: 'trace_id', timestamp: 'ts', body: 'msg' },
    };
    const sql = buildLogsByTraceIdQuery(cfg, 'abc123');
    expect(sql).not.toContain('undefined');
    expect(sql).toContain('SELECT ts AS timestamp, msg AS body');
  });
});

describe('resolveVolumeBreakdown', () => {
  it('falls back to "none" when severity breakdown is selected but severity is unmapped', () => {
    const cfg: SourceConfig = { ...arbitraryConfig, columns: { ...EMPTY_COLUMN_MAPPING } };
    expect(resolveVolumeBreakdown({ kind: 'severity' }, cfg)).toEqual({ kind: 'none' });
  });

  it('uses the mapped severity column when available', () => {
    const cfg: SourceConfig = { ...arbitraryConfig, columns: { ...EMPTY_COLUMN_MAPPING, severity: 'sev' } };
    expect(resolveVolumeBreakdown({ kind: 'severity' }, cfg)).toEqual({ kind: 'severity', expr: 'sev' });
  });
});

describe('buildSurroundingDocsQuery', () => {
  it('returns empty string when timestamp is unmapped', () => {
    const cfg: SourceConfig = { ...arbitraryConfig, columns: { ...EMPTY_COLUMN_MAPPING } };
    expect(buildSurroundingDocsQuery(cfg, '2026-01-01 00:00:00')).toBe('');
  });

  it('degrades gracefully when body is unmapped', () => {
    const cfg: SourceConfig = { ...arbitraryConfig, columns: { ...EMPTY_COLUMN_MAPPING, timestamp: 'ts' } };
    const sql = buildSurroundingDocsQuery(cfg, '2026-01-01 00:00:00');
    expect(sql).not.toContain('undefined');
    expect(sql).toContain("'' AS body");
  });
});
