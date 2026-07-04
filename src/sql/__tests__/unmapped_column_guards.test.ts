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
    const cfg: SourceConfig = { ...arbitraryConfig, columns: { ...EMPTY_COLUMN_MAPPING, logAttributes: 'attrs' } };
    const sql = buildMapKeysQuery(cfg, 'attrs');
    expect(sql).not.toContain('undefined');
    expect(sql).not.toContain('WHERE');
  });

  it('includes the time filter when timestamp is mapped', () => {
    const sql = buildMapKeysQuery(arbitraryConfig, 'attrs');
    expect(sql).toContain('WHERE ts >= $__fromTime');
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
