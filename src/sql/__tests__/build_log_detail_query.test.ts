/**
 * Unit tests for buildLogDetailQuery — the single-row point lookup that replaced hydratePage's
 * whole-page SELECT * on drawer-open (see queryBuilder.ts's doc comment for the reasoning).
 */

import { buildLogDetailQuery, CORE_ALIAS } from '../queryBuilder';
import { EMPTY_COLUMN_MAPPING, OTEL_COLUMN_MAPPING, SourceConfig } from '../../types';

const otelConfig: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'otel_logs',
  isOtel: true,
  columns: OTEL_COLUMN_MAPPING,
};

const noTimestampConfig: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'my_table',
  isOtel: false,
  columns: {
    ...EMPTY_COLUMN_MAPPING,
    body: 'msg',
    // timestamp deliberately left unmapped
  },
};

describe('buildLogDetailQuery', () => {
  it('narrows to a one-millisecond window plus core-field equality, not the full page', () => {
    const row = {
      [CORE_ALIAS.timestamp]: 1700000000123,
      [CORE_ALIAS.body]: 'hello world',
      [CORE_ALIAS.severity]: 'ERROR',
      [CORE_ALIAS.serviceName]: 'checkout',
    };
    const sql = buildLogDetailQuery(otelConfig, row);
    expect(sql).toContain('LIMIT 1');
    expect(sql).toContain('fromUnixTimestamp64Milli(1700000000123)');
    expect(sql).toContain('fromUnixTimestamp64Milli(1700000000124)');
    expect(sql).toContain(`${otelConfig.columns.body} = 'hello world'`);
    expect(sql).toContain(`${otelConfig.columns.severity} = 'ERROR'`);
    expect(sql).toContain(`${otelConfig.columns.serviceName} = 'checkout'`);
    // Never a whole-page OFFSET-based fetch.
    expect(sql).not.toContain('OFFSET');
  });

  it('accepts a raw ClickHouse DateTime64 string timestamp (sub-ms digits truncated, not exact-equality)', () => {
    const row = { [CORE_ALIAS.timestamp]: '2026-06-29 06:00:00.123456789' };
    const sql = buildLogDetailQuery(otelConfig, row);
    // 2026-06-29T06:00:00.123Z epoch ms
    const expectedMs = Date.parse('2026-06-29T06:00:00.123Z');
    expect(sql).toContain(`fromUnixTimestamp64Milli(${expectedMs})`);
    expect(sql).toContain(`fromUnixTimestamp64Milli(${expectedMs + 1})`);
  });

  it('only emits equality conditions for core fields actually present on the row', () => {
    const row = { [CORE_ALIAS.timestamp]: 1000 };
    const sql = buildLogDetailQuery(otelConfig, row);
    expect(sql).not.toContain(`${otelConfig.columns.body} =`);
    expect(sql).not.toContain(`${otelConfig.columns.severity} =`);
    expect(sql).not.toContain(`${otelConfig.columns.serviceName} =`);
  });

  it('returns empty string (no query) when no timestamp column is mapped', () => {
    const sql = buildLogDetailQuery(noTimestampConfig, { [CORE_ALIAS.body]: 'x' });
    expect(sql).toBe('');
  });

  it('returns empty string when the row has no parseable timestamp', () => {
    const sql = buildLogDetailQuery(otelConfig, { [CORE_ALIAS.timestamp]: 'not-a-date' });
    expect(sql).toBe('');
  });

  it('carries an execution guardrail (SETTINGS max_execution_time) that throws, not silently truncates', () => {
    const sql = buildLogDetailQuery(otelConfig, { [CORE_ALIAS.timestamp]: 1000 });
    expect(sql).toContain('SETTINGS max_execution_time');
    expect(sql).toContain("timeout_overflow_mode = 'throw'");
    expect(sql).not.toContain('max_rows_to_read');
    expect(sql).not.toContain("'break'");
  });

  it('includes select_sequential_consistency by default, so this point lookup and the list query it follows agree', () => {
    const sql = buildLogDetailQuery(otelConfig, { [CORE_ALIAS.timestamp]: 1000 });
    expect(sql).toContain('select_sequential_consistency = 1');
  });

  it('omits select_sequential_consistency when the view has it explicitly disabled', () => {
    const sql = buildLogDetailQuery({ ...otelConfig, sequentialConsistency: false }, { [CORE_ALIAS.timestamp]: 1000 });
    expect(sql).not.toContain('select_sequential_consistency');
  });
});

describe('buildLogDetailQuery — coarse index-pruning predicate (perf plan item 0)', () => {
  const withPrune: SourceConfig = {
    ...otelConfig,
    columns: { ...otelConfig.columns, partitionTimestamp: 'TimestampTime' },
  };

  it('appends the coarse predicate on the same 1ms window when partitionTimestamp resolves', () => {
    const sql = buildLogDetailQuery(withPrune, { [CORE_ALIAS.timestamp]: 1700000000123 });
    expect(sql).toContain('TimestampTime >= fromUnixTimestamp64Milli(1700000000123) - INTERVAL 1 SECOND');
    expect(sql).toContain('TimestampTime <= fromUnixTimestamp64Milli(1700000000124) + INTERVAL 1 SECOND');
  });

  it('omits the coarse predicate when partitionTimestamp is unset', () => {
    const unprunedConfig: SourceConfig = { ...otelConfig, columns: { ...otelConfig.columns, partitionTimestamp: '' } };
    const sql = buildLogDetailQuery(unprunedConfig, { [CORE_ALIAS.timestamp]: 1700000000123 });
    expect(sql).not.toContain('INTERVAL 1 SECOND');
  });

  it('omits the coarse predicate when explicitly off ("-")', () => {
    const offConfig: SourceConfig = { ...otelConfig, columns: { ...otelConfig.columns, partitionTimestamp: '-' } };
    const sql = buildLogDetailQuery(offConfig, { [CORE_ALIAS.timestamp]: 1700000000123 });
    expect(sql).not.toContain('INTERVAL 1 SECOND');
  });
});
