/**
 * Regression tests for Tier 1 audit items 2-6: query builders that used to interpolate
 * unconditional column references (emitting literal `undefined` into SQL, or a broken
 * time-bound WHERE clause) when the relevant column wasn't mapped. Each should now either
 * degrade gracefully (constant fallback, dropped WHERE clause) or bail out to an empty string
 * when the field the whole query hinges on (traceId, timestamp) is unmapped.
 */

import {
  buildSurroundingDocsQuery,
  buildVolumeQuery,
  resolveVolumeBreakdown,
} from '../queryBuilder';
import { buildMapKeysQuery } from '../introspection';
import { DEFAULT_QUERY_TIMEOUT_SECONDS } from '../settings';
import { FieldModel, selectMapColumns } from '../fieldModel';
import { EMPTY_COLUMN_MAPPING, SourceConfig } from '../../types';

const arbitraryConfig: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'my_table',
  isOtel: false,
  columns: { ...EMPTY_COLUMN_MAPPING, timestamp: 'ts' },
};

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
  it('omits ORDER BY (not "undefined") when timestamp is unmapped, but still bounds by LIMIT', () => {
    const cfg: SourceConfig = { ...arbitraryConfig, columns: { ...EMPTY_COLUMN_MAPPING } };
    const sql = buildMapKeysQuery(cfg, 'attrs', { table: cfg.logsTable, conditions: [] });
    expect(sql).not.toContain('undefined');
    expect(sql).not.toContain('ORDER BY');
    expect(sql).toContain('LIMIT 500');
  });

  it('scopes the sample by the caller-supplied WHERE conditions and orders by timestamp DESC', () => {
    const conditions = ['ts >= $__fromTime AND ts <= $__toTime'];
    const sql = buildMapKeysQuery(arbitraryConfig, 'attrs', { table: arbitraryConfig.logsTable, conditions });
    expect(sql).toContain('WHERE ts >= $__fromTime');
    expect(sql).toContain('ORDER BY ts DESC');
  });

  it('keeps the timeout guardrail on top of the LIMIT bound', () => {
    const sql = buildMapKeysQuery(arbitraryConfig, 'attrs', { table: arbitraryConfig.logsTable, conditions: [] });
    expect(sql).toContain(`max_execution_time = ${DEFAULT_QUERY_TIMEOUT_SECONDS}`);
    expect(sql).toContain("timeout_overflow_mode = 'throw'");
  });

  it('respects a custom table', () => {
    const sql = buildMapKeysQuery(arbitraryConfig, 'attrs', { table: 'custom_table', conditions: [] });
    expect(sql).toContain('"default"."custom_table"');
  });

  it('respects a custom sampleSize', () => {
    const sql = buildMapKeysQuery(arbitraryConfig, 'attrs', { table: arbitraryConfig.logsTable, conditions: [], sampleSize: 1000 });
    expect(sql).toContain('LIMIT 1000');
  });

  it('includes select_sequential_consistency by default', () => {
    const sql = buildMapKeysQuery(arbitraryConfig, 'attrs', { table: arbitraryConfig.logsTable, conditions: [] });
    expect(sql).toContain('select_sequential_consistency = 1');
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
