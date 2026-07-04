/**
 * Unit tests for buildLogsQuery's core SELECT list — specifically that unmapped optional
 * columns (severity/traceId/spanId/serviceName) are omitted entirely rather than emitted as a
 * constant '' AS x fallback, which used to risk colliding with a same-named column an arbitrary
 * table exposes via SELECT *.
 */

import { buildLogsQuery } from '../queryBuilder';
import { DEFAULT_LOGS_QUERY_STATE, EMPTY_COLUMN_MAPPING, OTEL_COLUMN_MAPPING, SourceConfig } from '../../types';

const otelConfig: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'otel_logs',
  tracesTable: 'otel_traces',
  isOtel: true,
  columns: OTEL_COLUMN_MAPPING,
};

const arbitraryConfig: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'my_table',
  tracesTable: '',
  isOtel: false,
  columns: {
    ...EMPTY_COLUMN_MAPPING,
    timestamp: 'ts',
    body: 'msg',
    // severity/traceId/spanId/serviceName left unmapped on purpose
  },
};

describe('buildLogsQuery core SELECT list', () => {
  it('emits all four optional aliases when fully mapped (OTel)', () => {
    const sql = buildLogsQuery(otelConfig, DEFAULT_LOGS_QUERY_STATE);
    expect(sql).toContain('AS severity');
    expect(sql).toContain('AS traceId');
    expect(sql).toContain('AS spanId');
    expect(sql).toContain('AS serviceName');
  });

  it('omits unmapped optional aliases entirely — no phantom empty-string columns', () => {
    const sql = buildLogsQuery(arbitraryConfig, DEFAULT_LOGS_QUERY_STATE);
    expect(sql).not.toContain('AS severity');
    expect(sql).not.toContain('AS traceId');
    expect(sql).not.toContain('AS spanId');
    expect(sql).not.toContain('AS serviceName');
    expect(sql).not.toContain("''");
    // Mapped columns are still present.
    expect(sql).toContain('ts AS timestamp');
    expect(sql).toContain('msg AS body');
  });

  it('does not collide with a same-named real column on an arbitrary table', () => {
    // Table has its own `severity` column that is NOT the mapped severity field — since the
    // mapping slot is unmapped, buildLogsQuery must not add a second `AS severity`, so SELECT *
    // (which already exposes the table's own `severity` column) never gets a duplicate alias.
    const sql = buildLogsQuery(arbitraryConfig, DEFAULT_LOGS_QUERY_STATE);
    const severityAliasCount = (sql.match(/AS severity/g) ?? []).length;
    expect(severityAliasCount).toBe(0);
  });
});
