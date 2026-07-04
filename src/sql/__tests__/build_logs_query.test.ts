/**
 * Unit tests for buildLogsQuery's core SELECT list:
 * - unmapped optional columns (severity/traceId/spanId/serviceName) are omitted entirely rather
 *   than emitted as a constant '' AS x fallback.
 * - mapped core columns are aliased under CORE_ALIAS's __-prefixed names, not their plain field
 *   name, so they can't collide with an arbitrary table's own same-named real column.
 */

import { buildLogsQuery, CORE_ALIAS } from '../queryBuilder';
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
  it('emits all four optional aliases (under CORE_ALIAS names) when fully mapped (OTel)', () => {
    const sql = buildLogsQuery(otelConfig, DEFAULT_LOGS_QUERY_STATE);
    expect(sql).toContain(`AS ${CORE_ALIAS.severity}`);
    expect(sql).toContain(`AS ${CORE_ALIAS.traceId}`);
    expect(sql).toContain(`AS ${CORE_ALIAS.spanId}`);
    expect(sql).toContain(`AS ${CORE_ALIAS.serviceName}`);
    // Never aliases to the field's own plain name.
    expect(sql).not.toContain('AS severity');
    expect(sql).not.toContain('AS traceId');
  });

  it('omits unmapped optional aliases entirely — no phantom empty-string columns', () => {
    const sql = buildLogsQuery(arbitraryConfig, DEFAULT_LOGS_QUERY_STATE);
    expect(sql).not.toContain(CORE_ALIAS.severity);
    expect(sql).not.toContain(CORE_ALIAS.traceId);
    expect(sql).not.toContain(CORE_ALIAS.spanId);
    expect(sql).not.toContain(CORE_ALIAS.serviceName);
    expect(sql).not.toContain("''");
    // Mapped columns are still present, aliased under their __-prefixed name.
    expect(sql).toContain(`ts AS ${CORE_ALIAS.timestamp}`);
    expect(sql).toContain(`msg AS ${CORE_ALIAS.body}`);
  });

  it('cannot collide with a same-named real column on an arbitrary table', () => {
    // Table has its own `severity` column (exposed via SELECT *, unrelated to the mapping).
    // Even when severity IS mapped, the __-prefixed alias can never equal a real column's name.
    const cfg: SourceConfig = { ...arbitraryConfig, columns: { ...arbitraryConfig.columns, severity: 'severity' } };
    const sql = buildLogsQuery(cfg, DEFAULT_LOGS_QUERY_STATE);
    expect(sql).toContain(`AS ${CORE_ALIAS.severity}`);
    expect(sql).not.toMatch(/AS severity(?!\w)/);
  });

  it('no longer aliases attribute Map columns (dead code removed — read via raw mapped name instead)', () => {
    const sql = buildLogsQuery(otelConfig, DEFAULT_LOGS_QUERY_STATE);
    expect(sql).not.toContain('AS ResourceAttributes');
    expect(sql).not.toContain('AS LogAttributes');
    expect(sql).not.toContain('AS ScopeAttributes');
  });
});
