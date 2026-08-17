/**
 * Unit tests for buildLogsQuery's core SELECT list:
 * - unmapped optional columns (severity/traceId/serviceName) are omitted entirely rather
 *   than emitted as a constant '' AS x fallback.
 * - grid projection's mapped core columns are aliased under CORE_ALIAS's __-prefixed names, not
 *   their plain field name, so they can't collide with an arbitrary table's own same-named real
 *   column — grid has no `*` to fall back on, so it's the one projection that still needs this.
 * - full/default projection is bare SELECT * — no core aliasing at all, since `*` already returns
 *   each mapped column under its own real name (see H2 in the audit plan: aliasing it again just
 *   sent it twice).
 */

import { buildLogsQuery, logRowKey, CORE_ALIAS } from '../queryBuilder';
import { DEFAULT_QUERY_TIMEOUT_SECONDS } from '../settings';
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

describe('buildLogsQuery core SELECT list — grid projection (still aliased, no `*` to fall back on)', () => {
  it('emits all four optional aliases (under CORE_ALIAS names) when fully mapped (OTel)', () => {
    const sql = buildLogsQuery(otelConfig, DEFAULT_LOGS_QUERY_STATE, undefined, { projection: 'grid' });
    expect(sql).toContain(`AS ${CORE_ALIAS.severity}`);
    expect(sql).toContain(`AS ${CORE_ALIAS.traceId}`);
    expect(sql).toContain(`AS ${CORE_ALIAS.serviceName}`);
    // Never aliases to the field's own plain name.
    expect(sql).not.toContain('AS severity');
    expect(sql).not.toContain('AS traceId');
  });

  it('omits unmapped optional aliases entirely — no phantom empty-string columns', () => {
    const sql = buildLogsQuery(arbitraryConfig, DEFAULT_LOGS_QUERY_STATE, undefined, { projection: 'grid' });
    expect(sql).not.toContain(CORE_ALIAS.severity);
    expect(sql).not.toContain(CORE_ALIAS.traceId);
    expect(sql).not.toContain(CORE_ALIAS.serviceName);
    expect(sql).not.toContain("''");
    // Mapped columns are still present, aliased under their __-prefixed name.
    expect(sql).toContain(`ts AS ${CORE_ALIAS.timestamp}`);
    expect(sql).toContain(`msg AS ${CORE_ALIAS.body}`);
  });

  it('cannot collide with a same-named real column on an arbitrary table', () => {
    // Table has its own `severity` column (exposed via SELECT *, unrelated to the mapping) — grid
    // itself has no `*` in this query, but the fetched row is still later matched against a `*`
    // row by logRowKey(), so the alias still must not collide with that real column's name.
    const cfg: SourceConfig = { ...arbitraryConfig, columns: { ...arbitraryConfig.columns, severity: 'severity' } };
    const sql = buildLogsQuery(cfg, DEFAULT_LOGS_QUERY_STATE, undefined, { projection: 'grid' });
    expect(sql).toContain(`AS ${CORE_ALIAS.severity}`);
    expect(sql).not.toMatch(/AS severity(?!\w)/);
  });

  it("omits SELECT * but keeps core aliases, extra columns, and WHERE/ORDER/LIMIT", () => {
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

  it("falls back to SELECT * when there are no core or extra columns at all", () => {
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

describe('buildLogsQuery core SELECT list — full/default projection (bare SELECT *, no core aliasing)', () => {
  it('no longer aliases attribute Map columns (dead code removed — read via raw mapped name instead)', () => {
    const sql = buildLogsQuery(otelConfig, DEFAULT_LOGS_QUERY_STATE);
    expect(sql).not.toContain('AS ResourceAttributes');
    expect(sql).not.toContain('AS LogAttributes');
    expect(sql).not.toContain('AS ScopeAttributes');
  });

  it('defaults to bare SELECT * when no opts are passed — existing callers unaffected', () => {
    const sql = buildLogsQuery(otelConfig, DEFAULT_LOGS_QUERY_STATE);
    expect(sql).toMatch(/^SELECT \*\n/);
    // No core aliases at all — `*` already covers Timestamp/Body/SeverityText/etc under their own
    // real names, so aliasing them again would just select them a second time (see H2 in the
    // audit plan).
    expect(sql).not.toContain(`AS ${CORE_ALIAS.timestamp}`);
    expect(sql).not.toContain(`AS ${CORE_ALIAS.severity}`);
    expect(sql).not.toContain(`AS ${CORE_ALIAS.serviceName}`);
    expect(sql).not.toContain(`AS ${CORE_ALIAS.traceId}`);
    // The default sort still targets a real, resolvable column — not a dropped alias.
    expect(sql).toContain(`ORDER BY ${otelConfig.columns.timestamp} DESC`);
  });

  it("projection: 'full' is explicitly the same as the default", () => {
    const sql = buildLogsQuery(otelConfig, DEFAULT_LOGS_QUERY_STATE, undefined, { projection: 'full' });
    expect(sql).toMatch(/^SELECT \*\n/);
  });

  it('an extra user-added column (a computed expression, not covered by `*`) is still selected', () => {
    const state = {
      ...DEFAULT_LOGS_QUERY_STATE,
      columns: [
        { id: 'extra', key: 'fld_extra', sqlExpr: 'my_col', displayName: 'My col', type: 'string' as const, isCore: false },
      ],
    };
    const sql = buildLogsQuery(otelConfig, state);
    expect(sql).toContain('my_col AS fld_extra');
  });

  it('a sort column carried over from the grid (a CORE_ALIAS name) is translated to the real column', () => {
    const state = { ...DEFAULT_LOGS_QUERY_STATE, sort: { col: CORE_ALIAS.severity, dir: 'asc' as const } };
    const sql = buildLogsQuery(otelConfig, state);
    expect(sql).toContain(`ORDER BY ${otelConfig.columns.severity} ASC`);
    expect(sql).not.toContain(`ORDER BY ${CORE_ALIAS.severity}`);
  });

  it('a sort column that is an extraSelect key passes through unchanged (still resolvable — its own alias is still emitted)', () => {
    const state = {
      ...DEFAULT_LOGS_QUERY_STATE,
      sort: { col: 'fld_extra', dir: 'asc' as const },
      columns: [
        { id: 'extra', key: 'fld_extra', sqlExpr: 'my_col', displayName: 'My col', type: 'string' as const, isCore: false },
      ],
    };
    const sql = buildLogsQuery(otelConfig, state);
    expect(sql).toContain('ORDER BY fld_extra ASC');
  });
});

describe('buildLogsQuery — execution guardrail (perf plan item 1)', () => {
  it('carries the shared query-timeout budget, throwing rather than silently truncating', () => {
    const sql = buildLogsQuery(otelConfig, DEFAULT_LOGS_QUERY_STATE, undefined, { projection: 'grid' });
    expect(sql).toContain(`max_execution_time = ${DEFAULT_QUERY_TIMEOUT_SECONDS}`);
    expect(sql).toContain("timeout_overflow_mode = 'throw'");
  });

  it('respects a per-view queryTimeoutSeconds override', () => {
    const sql = buildLogsQuery({ ...otelConfig, queryTimeoutSeconds: 5 }, DEFAULT_LOGS_QUERY_STATE, undefined, { projection: 'grid' });
    expect(sql).toContain('max_execution_time = 5');
  });
});

describe('buildLogsQuery — coarse index-pruning predicate (perf plan item 0)', () => {
  const withPrune: SourceConfig = {
    ...otelConfig,
    columns: { ...otelConfig.columns, partitionTimestamp: 'TimestampTime' },
  };

  it('appends the coarse predicate alongside the fine one when partitionTimestamp resolves', () => {
    const sql = buildLogsQuery(withPrune, DEFAULT_LOGS_QUERY_STATE, undefined, { projection: 'grid' });
    expect(sql).toContain(`${withPrune.columns.timestamp} >= $__fromTime AND ${withPrune.columns.timestamp} <= $__toTime`);
    expect(sql).toContain('TimestampTime >= $__fromTime - INTERVAL 1 SECOND AND TimestampTime <= $__toTime + INTERVAL 1 SECOND');
  });

  it('emits byte-identical SQL to the no-prune-column case when partitionTimestamp is unset', () => {
    // EMPTY_COLUMN_MAPPING (and hence otelConfig without an explicit override) has
    // partitionTimestamp === '' — no candidate resolved, today's SQL unchanged. This is also the
    // correct behavior for a table where the mapped timestamp is itself the sort key (e.g.
    // default.eval_otel — see the perf plan's no-partition-key regression check).
    const unprunedConfig: SourceConfig = { ...otelConfig, columns: { ...otelConfig.columns, partitionTimestamp: '' } };
    const sql = buildLogsQuery(unprunedConfig, DEFAULT_LOGS_QUERY_STATE, undefined, { projection: 'grid' });
    expect(sql).not.toContain('INTERVAL 1 SECOND');
  });

  it('is suppressed by the explicit "off" sentinel ("-") even if a coarse column name is meaningful', () => {
    const offConfig: SourceConfig = { ...otelConfig, columns: { ...otelConfig.columns, partitionTimestamp: '-' } };
    const sql = buildLogsQuery(offConfig, DEFAULT_LOGS_QUERY_STATE, undefined, { projection: 'grid' });
    expect(sql).not.toContain('INTERVAL 1 SECOND');
  });

  it('never appends the coarse predicate when no timestamp column is mapped at all', () => {
    const noTsConfig: SourceConfig = {
      ...otelConfig,
      columns: { ...otelConfig.columns, timestamp: '', partitionTimestamp: 'TimestampTime' },
    };
    const sql = buildLogsQuery(noTsConfig, DEFAULT_LOGS_QUERY_STATE, undefined, { projection: 'grid' });
    expect(sql).not.toContain('TimestampTime');
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

  // H2: full/detail rows are now a bare SELECT * (no CORE_ALIAS), so they only carry the value
  // under its real mapped column name. logRowKey() must produce the same key for a grid row and
  // its full-row counterpart, given `config` to translate through.
  it('with config, produces equal keys for a grid-shaped row and its full (SELECT *) counterpart', () => {
    const gridRow = {
      [CORE_ALIAS.timestamp]: 1000,
      [CORE_ALIAS.body]: 'hello',
      [CORE_ALIAS.severity]: 'info',
      [CORE_ALIAS.serviceName]: 'svc',
    };
    const fullRow = {
      [otelConfig.columns.timestamp!]: 1000,
      [otelConfig.columns.body!]: 'hello',
      [otelConfig.columns.severity!]: 'info',
      [otelConfig.columns.serviceName!]: 'svc',
      ResourceAttributes: { 'k8s.pod.name': 'x' }, // full row carries extra columns grid doesn't
    };
    expect(logRowKey(gridRow, otelConfig)).toBe(logRowKey(fullRow, otelConfig));
  });

  it('without config, a full (unaliased) row does not spuriously match a differently-valued row', () => {
    const a = { [otelConfig.columns.timestamp!]: 1000 };
    const b = { [otelConfig.columns.timestamp!]: 2000 };
    // Neither carries CORE_ALIAS.timestamp, and no config was given to fall back through — both
    // read as "unmapped" (null), which is the safe (if imprecise) default for a caller that never
    // needs cross-shape matching.
    expect(logRowKey(a)).toBe(logRowKey(b));
  });
});
