/**
 * Regression tests for Tier 1 audit items 2-6: query builders that used to interpolate
 * unconditional column references (emitting literal `undefined` into SQL, or a broken
 * time-bound WHERE clause) when the relevant column wasn't mapped. Each should now either
 * degrade gracefully (constant fallback, dropped WHERE clause) or bail out to an empty string
 * when the field the whole query hinges on (traceId, timestamp) is unmapped.
 */

import {
  buildSurroundingDocsQuery,
  buildTraceDetailQuery,
  buildTraceSearchQuery,
  buildVolumeQuery,
} from '../queryBuilder';
import { buildMapKeysQuery } from '../introspection';
import { EMPTY_COLUMN_MAPPING, OTEL_COLUMN_MAPPING, SourceConfig } from '../../types';

const otelConfig: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'otel_logs',
  tracesTable: 'otel_traces',
  isOtel: true,
  columns: OTEL_COLUMN_MAPPING,
};

const noTraceIdConfig: SourceConfig = {
  ...otelConfig,
  columns: { ...OTEL_COLUMN_MAPPING, traceId: '' },
};

const noTimestampTracesConfig: SourceConfig = {
  ...otelConfig,
  columns: { ...OTEL_COLUMN_MAPPING, timestamp: '', duration: '', serviceName: '' },
};

const arbitraryConfig: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'my_table',
  tracesTable: '',
  isOtel: false,
  columns: { ...EMPTY_COLUMN_MAPPING, timestamp: 'ts' },
};

describe('buildTraceSearchQuery', () => {
  it('returns empty string when traceId is unmapped', () => {
    expect(buildTraceSearchQuery(noTraceIdConfig, '')).toBe('');
  });

  it('degrades gracefully (no "undefined") when timestamp/serviceName/duration are unmapped', () => {
    const sql = buildTraceSearchQuery(noTimestampTracesConfig, 'checkout');
    expect(sql).not.toContain('undefined');
    expect(sql).toContain("'' AS serviceName");
    expect(sql).toContain('0 AS startTime');
    expect(sql).toContain('0 AS durationNs');
    expect(sql).not.toContain('WHERE'); // no timestamp filter, no service search applied
  });
});

describe('buildTraceDetailQuery', () => {
  it('returns empty string when traceId is unmapped', () => {
    expect(buildTraceDetailQuery(noTraceIdConfig, 'abc')).toBe('');
  });

  it('degrades gracefully when parentSpanId/serviceName/timestamp/duration are unmapped', () => {
    const cfg: SourceConfig = {
      ...otelConfig,
      columns: { ...OTEL_COLUMN_MAPPING, parentSpanId: '', serviceName: '', timestamp: '', duration: '' },
    };
    const sql = buildTraceDetailQuery(cfg, 'abc');
    expect(sql).not.toContain('undefined');
    expect(sql).toContain("'' AS parentSpanID");
    expect(sql).toContain("'' AS serviceName");
    expect(sql).toContain('0 AS startTime');
    expect(sql).toContain('0 AS durationNs');
  });
});

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
