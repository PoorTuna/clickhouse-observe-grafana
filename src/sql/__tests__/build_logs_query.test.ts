/**
 * Unit tests for buildLogsQuery's core SELECT list:
 * - unmapped optional columns (severity/traceId/serviceName) are omitted entirely rather
 *   than emitted as a constant '' AS x fallback.
 * - mapped core columns are aliased under CORE_ALIAS's __-prefixed names, not their plain field
 *   name, so they can't collide with an arbitrary table's own same-named real column.
 */

import { buildLogsQuery, logRowKey, CORE_ALIAS } from '../queryBuilder';
import { DEFAULT_LOGS_QUERY_STATE, EMPTY_COLUMN_MAPPING, OTEL_COLUMN_MAPPING, SourceConfig } from '../../types';

const otelConfig: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'otel_logs',
  isOtel: true,
  columns: OTEL_COLUMN_MAPPING,
};

const arbitraryConfig: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'my_table',
  isOtel: false,
  columns: {
    ...EMPTY_COLUMN_MAPPING,
    timestamp: 'ts',
    body: 'msg',
    // severity/traceId/serviceName left unmapped on purpose
  },
};

describe('buildLogsQuery core SELECT list', () => {
  it('emits all four optional aliases (under CORE_ALIAS names) when fully mapped (OTel)', () => {
    const sql = buildLogsQuery(otelConfig, DEFAULT_LOGS_QUERY_STATE);
    expect(sql).toContain(`AS ${CORE_ALIAS.severity}`);
    expect(sql).toContain(`AS ${CORE_ALIAS.traceId}`);
    expect(sql).toContain(`AS ${CORE_ALIAS.serviceName}`);
    // Never aliases to the field's own plain name.
    expect(sql).not.toContain('AS severity');
    expect(sql).not.toContain('AS traceId');
  });

  it('omits unmapped optional aliases entirely — no phantom empty-string columns', () => {
    const sql = buildLogsQuery(arbitraryConfig, DEFAULT_LOGS_QUERY_STATE);
    expect(sql).not.toContain(CORE_ALIAS.severity);
    expect(sql).not.toContain(CORE_ALIAS.traceId);
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

  it('defaults to SELECT * (full projection) when no opts are passed — existing callers unaffected', () => {
    const sql = buildLogsQuery(otelConfig, DEFAULT_LOGS_QUERY_STATE);
    expect(sql).toMatch(/^SELECT \*,/);
  });

  it("projection: 'full' is explicitly the same as the default", () => {
    const sql = buildLogsQuery(otelConfig, DEFAULT_LOGS_QUERY_STATE, undefined, { projection: 'full' });
    expect(sql).toMatch(/^SELECT \*,/);
  });

  it("projection: 'grid' omits SELECT * but keeps core aliases, extra columns, and WHERE/ORDER/LIMIT", () => {
    const state = {
      ...DEFAULT_LOGS_QUERY_STATE,
      columns: [
        { id: 'extra', key: 'fld_extra', sqlExpr: 'my_col', displayName: 'My col', type: 'string' as const, isCore: false },
      ],
    };
    const sql = buildLogsQuery(otelConfig, state, { limit: 50, offset: 100 }, { projection: 'grid' });
    expect(sql).not.toMatch(/^SELECT \*/);
    expect(sql).not.toContain('SELECT *,');
    expect(sql).toContain(`AS ${CORE_ALIAS.timestamp}`);
    expect(sql).toContain(`AS ${CORE_ALIAS.severity}`);
    expect(sql).toContain('my_col AS fld_extra');
    expect(sql).toContain('WHERE');
    expect(sql).toContain('ORDER BY');
    expect(sql).toContain('LIMIT 50 OFFSET 100');
  });

  it("projection: 'grid' falls back to SELECT * when there are no core or extra columns at all", () => {
    // Arbitrary table with nothing mapped and no user-added columns — an empty SELECT list
    // would be invalid SQL, so 'grid' must degrade to '*' rather than producing "SELECT FROM t".
    const emptyConfig: SourceConfig = {
      datasourceUid: 'test',
      database: 'default',
      logsTable: 'my_table',
      isOtel: false,
      columns: { ...EMPTY_COLUMN_MAPPING },
    };
    const sql = buildLogsQuery(emptyConfig, DEFAULT_LOGS_QUERY_STATE, undefined, { projection: 'grid' });
    expect(sql).toMatch(/^SELECT \*/);
  });
});

describe('logRowKey', () => {
  it('produces equal keys for rows with equal core values', () => {
    const a = { [CORE_ALIAS.timestamp]: 1000, [CORE_ALIAS.body]: 'hello', [CORE_ALIAS.severity]: 'info', [CORE_ALIAS.serviceName]: 'svc' };
    const b = { [CORE_ALIAS.timestamp]: 1000, [CORE_ALIAS.body]: 'hello', [CORE_ALIAS.severity]: 'info', [CORE_ALIAS.serviceName]: 'svc', extra: 'ignored' };
    expect(logRowKey(a)).toBe(logRowKey(b));
  });

  it('produces different keys when any core value differs', () => {
    const a = { [CORE_ALIAS.timestamp]: 1000, [CORE_ALIAS.body]: 'hello' };
    const b = { [CORE_ALIAS.timestamp]: 1001, [CORE_ALIAS.body]: 'hello' };
    expect(logRowKey(a)).not.toBe(logRowKey(b));
  });

  it('tolerates unmapped/undefined core values on both sides', () => {
    const a = { [CORE_ALIAS.timestamp]: 1000 };
    const b = { [CORE_ALIAS.timestamp]: 1000 };
    expect(logRowKey(a)).toBe(logRowKey(b));
  });
});
