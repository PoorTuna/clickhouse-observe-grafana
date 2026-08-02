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

  it('carries an execution guardrail (SETTINGS max_execution_time)', () => {
    const sql = buildLogDetailQuery(otelConfig, { [CORE_ALIAS.timestamp]: 1000 });
    expect(sql).toContain('SETTINGS max_execution_time');
  });
});
