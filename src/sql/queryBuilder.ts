/**
 * ClickHouse SQL generation for logs, volume, and trace queries.
 * Adapted from grafana/clickhouse-datasource src/data/sqlGenerator.ts (Apache-2.0).
 *
 * Uses $__fromTime / $__toTime macros — the CH datasource backend expands these
 * from the query request's time range automatically.
 */

import { BreakdownSel, FilterPill, FilterOp, LogsQueryState, SourceConfig, TraceListFilters } from '../types';
import { resolveField } from './fields';
import { parseKql, kqlToSql } from './kql';

/**
 * Row-object keys for buildLogsQuery's core (fixed-role) columns. `__`-prefixed so they can't
 * collide with an arbitrary table's own real column of the same plain name — see buildLogsQuery.
 * Consumers (LogsTable, LogDetailDrawer, defaultColumns()) import this instead of hardcoding the
 * literal strings so the two sides can't drift.
 */
export const CORE_ALIAS = {
  timestamp: '__timestamp',
  body: '__body',
  severity: '__severity',
  traceId: '__traceId',
  spanId: '__spanId',
  serviceName: '__serviceName',
} as const;

export function quoteIdentifier(name: string): string {
  if (name.includes('[') || name.includes('(') || name.includes('.')) {
    return name;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function tableRef(config: SourceConfig, table: string): string {
  return `"${config.database}"."${table}"`;
}

function filterOpToSql(op: FilterOp): string {
  switch (op) {
    case '=':
      return '=';
    case '!=':
      return '!=';
    case 'contains':
      return 'ILIKE';
    case 'not_contains':
      return 'NOT ILIKE';
    case 'one_of':
      return 'IN';
    case 'not_one_of':
      return 'NOT IN';
    case 'exists':
    case 'not_exists':
      return ''; // handled separately below
  }
}

function buildFilterClause(filter: FilterPill, config: SourceConfig): string {
  const value = filter.value.trim();
  const resolved = resolveField(filter.field, config);
  const sqlExprRaw = resolved ? resolved.sqlExpr : filter.field;

  // exists / not_exists — value is irrelevant
  if (filter.op === 'exists') {
    return `notEmpty(toString(${sqlExprRaw}))`;
  }
  if (filter.op === 'not_exists') {
    return `empty(toString(${sqlExprRaw}))`;
  }

  // one_of / not_one_of — use IN (...) / NOT IN (...)
  if (filter.op === 'one_of' || filter.op === 'not_one_of') {
    const vals = filter.values?.length ? filter.values : value ? [value] : [];
    if (vals.length === 0) {
      // guard: empty value set → always false / always true
      return filter.op === 'one_of' ? '1=0' : '1=1';
    }
    const col = quoteIdentifier(sqlExprRaw);
    const list = vals.map(quoteString).join(', ');
    return filter.op === 'one_of'
      ? `${col} IN (${list})`
      : `${col} NOT IN (${list})`;
  }

  // Standard single-value ops: =, !=, contains, not_contains
  const negate = filter.op === '!=' || filter.op === 'not_contains';

  if (resolved === null) {
    // Unknown field: treat the field name as a direct column, same as the KQL path.
    // Avoids emitting `undefined ILIKE …` when body is unmapped.
    const col = quoteIdentifier(sqlExprRaw);
    const op = filterOpToSql(filter.op);
    if (op === 'ILIKE' || op === 'NOT ILIKE') {
      return `${col} ${op} ${quoteString('%' + value + '%')}`;
    }
    return `${col} ${op} ${quoteString(value)}`;
  }

  const { sqlExpr, kind } = resolved;

  if (kind === 'text') {
    return negate
      ? `${sqlExpr} NOT ILIKE ${quoteString('%' + value + '%')}`
      : `${sqlExpr} ILIKE ${quoteString('%' + value + '%')}`;
  }

  const col = quoteIdentifier(sqlExpr);
  const op = filterOpToSql(filter.op);
  if (op === 'ILIKE' || op === 'NOT ILIKE') {
    return `${col} ${op} ${quoteString('%' + value + '%')}`;
  }
  return `${col} ${op} ${quoteString(value)}`;
}

export function buildSearchClause(search: string, config: SourceConfig): string {
  const term = search.trim();
  if (!term) {
    return '';
  }

  // Try to parse as KQL first.
  try {
    const ast = parseKql(term);
    return kqlToSql(ast, config);
  } catch {
    // Fall back to legacy free-text body search on any parse error so existing
    // queries and partial input never break a live result set.
  }

  // Legacy fallback: tokenize and ILIKE/hasToken on body.
  const c = config.columns;
  // No body column mapped → can't do free-text search; skip rather than emit hasToken(undefined,…).
  if (!c.body) {
    return '';
  }
  const terms = term.match(/"[^"]*"|'[^']*'|\S+/g) ?? [term];
  const clauses = terms.map((t) => {
    const clean = t.replace(/^["']|["']$/g, '');
    const quoted = quoteString(clean);
    return `(hasToken(${c.body}, ${quoted}) OR ${c.body} ILIKE ${quoteString('%' + clean + '%')})`;
  });
  return clauses.length === 1 ? clauses[0] : clauses.map((cl) => `(${cl})`).join(' AND ');
}

/** Build the WHERE conditions shared across logs, volume, and field-stats queries. */
export function buildWhereConditions(config: SourceConfig, state: LogsQueryState): string[] {
  const conditions: string[] = [];
  // Only add the time filter when a timestamp column is mapped (no-time views skip this).
  if (config.columns.timestamp) {
    conditions.push(
      `${config.columns.timestamp} >= $__fromTime AND ${config.columns.timestamp} <= $__toTime`
    );
  }
  if (state.search.trim()) {
    conditions.push(buildSearchClause(state.search, config));
  }
  for (const f of state.filters) {
    conditions.push(buildFilterClause(f, config));
  }
  return conditions;
}

export function buildLogsQuery(
  config: SourceConfig,
  state: LogsQueryState,
  pagination?: { limit: number; offset: number }
): string {
  const c = config.columns;
  const tbl = tableRef(config, config.logsTable);

  // Core aliases for mapped columns only, omitted entirely when unmapped. Aliased under a
  // `__`-prefixed name (CORE_ALIAS.*) rather than the field's plain name — an arbitrary table's
  // own real column can legitimately be named `timestamp`/`body`/`severity`/etc (unrelated to
  // what the user mapped to that role); a `__`-prefixed alias can't collide with a pre-existing
  // column the way a bare name can, closing off the whole collision class rather than special-
  // casing individual instances of it. Note: ResourceAttributes/LogAttributes/ScopeAttributes
  // are deliberately NOT aliased here — groupAttributes() (schema.ts) already reads them by
  // their raw mapped column name via SELECT *, so a fixed alias was dead weight.
  const coreSelect = [
    c.timestamp ? `${c.timestamp} AS ${CORE_ALIAS.timestamp}` : null,
    c.body ? `${c.body} AS ${CORE_ALIAS.body}` : null,
    c.severity ? `${c.severity} AS ${CORE_ALIAS.severity}` : null,
    c.traceId ? `${c.traceId} AS ${CORE_ALIAS.traceId}` : null,
    c.spanId ? `${c.spanId} AS ${CORE_ALIAS.spanId}` : null,
    c.serviceName ? `${c.serviceName} AS ${CORE_ALIAS.serviceName}` : null,
  ].filter(Boolean) as string[];

  // Extra SELECT for user-added non-core columns
  const extraSelect = (state.columns ?? [])
    .filter((col) => !col.isCore)
    .map((col) => `${col.sqlExpr} AS ${col.key}`);

  const selectParts = ['*', ...coreSelect, ...extraSelect];
  const conditions = buildWhereConditions(config, state);

  const sortCol = state.sort?.col ?? (c.timestamp ? CORE_ALIAS.timestamp : null);
  const sortDir = (state.sort?.dir ?? 'desc').toUpperCase();

  return [
    `SELECT ${selectParts.join(', ')}`,
    `FROM ${tbl}`,
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : null,
    sortCol ? `ORDER BY ${sortCol} ${sortDir}` : null,
    pagination
      ? `LIMIT ${pagination.limit} OFFSET ${pagination.offset}`
      : `LIMIT ${state.limit}`,
  ].filter(Boolean).join('\n');
}

export type CHIntervalUnit = 'SECOND' | 'MINUTE' | 'HOUR' | 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';

export type VolumeBreakdown =
  /** One bar per bucket, no per-series coloring. */
  | { kind: 'none' }
  /** Stack by severity column — no CTE, same as the original query. */
  | { kind: 'severity'; expr: string }
  /** Top-N breakdown by a chosen field expression + 'Other' catch-all via CTE. */
  | { kind: 'field'; expr: string; limit?: number };

export interface VolumeQueryOpts {
  /**
   * Fixed bucket width, or `{ macro: true }` to defer bucketing to the CH datasource's
   * `$__timeInterval(...)` macro — used when exporting to a dashboard panel so the bucket
   * width adapts to whatever time range the dashboard is showing, not the range at export time.
   */
  interval: { unit: CHIntervalUnit; value: number } | { macro: true };
  breakdown: VolumeBreakdown;
}

export function buildVolumeQuery(
  config: SourceConfig,
  state: LogsQueryState,
  opts: VolumeQueryOpts
): string {
  const c = config.columns;
  // Bucketing by time is the entire point of a volume query — meaningless without a mapped
  // timestamp column. Callers already gate execution on caps.hasTime, but the builder itself
  // shouldn't rely on every caller remembering that (panelExport.ts is a second such caller).
  if (!c.timestamp) {
    return '';
  }
  const tbl = tableRef(config, config.logsTable);
  const { interval, breakdown } = opts;
  const timeExpr = 'macro' in interval
    ? `$__timeInterval(${c.timestamp})`
    : `toStartOfInterval(${c.timestamp}, INTERVAL ${interval.value} ${interval.unit})`;
  const conditions = buildWhereConditions(config, state);
  const condSql = conditions.join(' AND ');

  const whereSql = condSql ? `WHERE ${condSql}` : '';

  if (breakdown.kind === 'none') {
    // Single series: constant empty-string level so the fold loop stays generic.
    return [
      `SELECT ${timeExpr} AS time, '' AS level, count() AS count`,
      `FROM ${tbl}`,
      whereSql || null,
      `GROUP BY time, level`,
      `ORDER BY time ASC`,
    ].filter(Boolean).join('\n');
  }

  if (breakdown.kind === 'severity') {
    // Stack by severity column — no CTE, identical to the original behaviour.
    // Lowercase in SQL (not just client-side) so mixed-case severity values (e.g. 'ERROR' vs
    // 'error' from different log sources) group into one bucket/series instead of duplicating.
    return [
      `SELECT ${timeExpr} AS time, lower(toString(${breakdown.expr})) AS level, count() AS count`,
      `FROM ${tbl}`,
      whereSql || null,
      `GROUP BY time, level`,
      `ORDER BY time ASC`,
    ].filter(Boolean).join('\n');
  }

  // Field breakdown: compute top-N server-side so 'Other' is one aggregated series.
  const limit = breakdown.limit ?? 10;
  const exprStr = `toString(${breakdown.expr})`;
  return [
    `WITH top AS (`,
    `  SELECT ${exprStr} AS v`,
    `  FROM ${tbl}`,
    whereSql ? `  ${whereSql}` : null,
    `  GROUP BY v ORDER BY count() DESC LIMIT ${limit}`,
    `)`,
    `SELECT ${timeExpr} AS time,`,
    `       if(${exprStr} GLOBAL IN (SELECT v FROM top), ${exprStr}, 'Other') AS level,`,
    `       count() AS count`,
    `FROM ${tbl}`,
    whereSql || null,
    `GROUP BY time, level`,
    `ORDER BY time ASC`,
  ].filter(Boolean).join('\n');
}

/**
 * Map the UI-level breakdown selection to the SQL-level VolumeBreakdown.
 * Shared by the live histogram query (LogsExplorer) and dashboard-panel export so the two
 * never drift apart.
 */
export function resolveVolumeBreakdown(breakdown: BreakdownSel, config: SourceConfig): VolumeBreakdown {
  switch (breakdown.kind) {
    case 'none':
      return { kind: 'none' };
    case 'severity':
      return config.columns.severity ? { kind: 'severity', expr: config.columns.severity } : { kind: 'none' };
    case 'field':
      return { kind: 'field', expr: breakdown.field.sqlExpr };
  }
}

export interface FieldTopValuesOpts {
  /** Table to sample from (e.g. config.logsTable or config.tracesTable). */
  table: string;
  /** Pre-built WHERE conditions (from buildWhereConditions / buildTraceWhereConditions). */
  conditions: string[];
  limit?: number;
  sampleSize?: number;
}

export function buildFieldTopValuesQuery(
  config: SourceConfig,
  sqlExpr: string,
  opts: FieldTopValuesOpts
): string {
  const { table, conditions, limit = 10, sampleSize = 500 } = opts;
  const tbl = tableRef(config, table);
  const tsCol = config.columns.timestamp;

  // Sample the most-recent sampleSize rows then aggregate within the sample.
  // Keeps query cost O(sampleSize) regardless of table size.
  // The scalar subquery returns total sampled rows so the UI can show
  // "Calculated from N records" with real percentages.
  const condClause = conditions.length > 0 ? `  WHERE ${conditions.join(' AND ')}` : null;
  return [
    `WITH sample AS (`,
    `  SELECT toString(${sqlExpr}) AS value`,
    `  FROM ${tbl}`,
    condClause,
    tsCol ? `  ORDER BY ${tsCol} DESC` : null,
    `  LIMIT ${sampleSize}`,
    `)`,
    `SELECT value, count() AS count, sum(count()) OVER () AS total`,
    `FROM sample`,
    `WHERE notEmpty(value)`,
    `GROUP BY value`,
    `ORDER BY count DESC`,
    `LIMIT ${limit}`,
  ].filter(Boolean).join('\n');
}

export function buildSurroundingDocsQuery(
  config: SourceConfig,
  rowTimestamp: string,
  n = 25,
  direction: 'before' | 'after' = 'before'
): string {
  const c = config.columns;
  // Finding "surrounding" docs is inherently a time-proximity query — meaningless without a
  // mapped timestamp column, so gate the whole function rather than emit `undefined` into SQL.
  if (!c.timestamp) {
    return '';
  }
  const tbl = tableRef(config, config.logsTable);
  const op = direction === 'before' ? '<' : '>';
  const order = direction === 'before' ? 'DESC' : 'ASC';

  return [
    `SELECT ${c.timestamp} AS timestamp, ${c.body || "''"} AS body,`,
    `  ${c.severity || "''"} AS severity, ${c.serviceName || "''"} AS serviceName`,
    `FROM ${tbl}`,
    `WHERE ${c.timestamp} ${op} ${quoteString(rowTimestamp)}`,
    `ORDER BY ${c.timestamp} ${order}`,
    `LIMIT ${n}`,
  ].join('\n');
}

// Traces is OTel-only by design (see buildTraceListQuery / buildTraceDetailQuery below): traceId/
// spanId/parentSpanId/status-code semantics, the Events.*/Links.* nested columns, and the
// `<table>_trace_id_ts` materialized-view naming convention all assume the ClickHouse OTel exporter
// schema. This mirrors the STATUS_CODE_ERROR literal already used before this file was extended.
const OTEL_STATUS_ERROR = 'STATUS_CODE_ERROR';

/**
 * Build the WHERE conditions for trace list + trace volume queries.
 * Mirrors buildWhereConditions (logs) but traces has no body column, so free-text search falls
 * back to a spanName ILIKE instead of a hasToken/body search when KQL parsing doesn't apply.
 */
export function buildTraceWhereConditions(config: SourceConfig, filters: TraceListFilters): string[] {
  const c = config.columns;
  const conditions: string[] = [];

  if (c.timestamp) {
    conditions.push(`${c.timestamp} >= $__fromTime AND ${c.timestamp} <= $__toTime`);
  }
  const search = filters.search.trim();
  if (search) {
    const clause = buildSearchClause(search, config);
    // '' → no body column and KQL parse failed outright; '1=1' → kqlToSql's own no-op sentinel
    // for a bare term it can't resolve without a body column (see kql/toSql.ts). Both mean
    // "the term went nowhere" — fall back to matching the operation name instead of silently
    // dropping the search (empty string) or silently matching everything ('1=1').
    if (clause && clause !== '1=1') {
      conditions.push(clause);
    } else if (c.spanName) {
      conditions.push(`${c.spanName} ILIKE ${quoteString('%' + search + '%')}`);
    }
  }
  if (filters.service.trim() && c.serviceName) {
    conditions.push(`${c.serviceName} ILIKE ${quoteString('%' + filters.service.trim() + '%')}`);
  }
  if (filters.spanName.trim() && c.spanName) {
    conditions.push(`${c.spanName} ILIKE ${quoteString('%' + filters.spanName.trim() + '%')}`);
  }
  if (filters.spanKind.trim() && c.spanKind) {
    conditions.push(`${c.spanKind} = ${quoteString(filters.spanKind.trim())}`);
  }
  if (filters.status !== 'any' && c.statusCode) {
    conditions.push(
      filters.status === 'error'
        ? `${c.statusCode} = ${quoteString(OTEL_STATUS_ERROR)}`
        : `${c.statusCode} != ${quoteString(OTEL_STATUS_ERROR)}`
    );
  }
  if (c.duration) {
    if (filters.minDurationNs !== undefined) {
      conditions.push(`${c.duration} >= ${filters.minDurationNs}`);
    }
    if (filters.maxDurationNs !== undefined) {
      conditions.push(`${c.duration} <= ${filters.maxDurationNs}`);
    }
  }
  for (const f of filters.pills) {
    conditions.push(buildFilterClause(f, config));
  }
  return conditions;
}

export interface TraceListSort {
  col: 'startTime' | 'duration';
  dir: 'asc' | 'desc';
}

export interface TraceListPagination {
  limit: number;
  offset: number;
}

/**
 * One row per trace, aggregated over the traces table. Root service/operation are derived from
 * the span whose parentSpanId is empty (the true root span); if no root span is present in the
 * window (e.g. it fell outside the time range, or was sampled out), falls back to the
 * earliest-starting span so the row is never blank.
 */
export function buildTraceListQuery(
  config: SourceConfig,
  filters: TraceListFilters,
  sort: TraceListSort = { col: 'startTime', dir: 'desc' },
  pagination: TraceListPagination = { limit: 100, offset: 0 }
): string {
  const c = config.columns;
  // No traceId mapped → no trace concept at all; same gating style as buildLogsByTraceIdQuery.
  if (!c.traceId) {
    return '';
  }
  const tbl = tableRef(config, config.tracesTable);
  const conditions = buildTraceWhereConditions(config, filters);

  const errorCountExpr = c.statusCode ? `countIf(${c.statusCode} = ${quoteString(OTEL_STATUS_ERROR)})` : '0';
  const serviceCountExpr = c.serviceName ? `uniqExact(${c.serviceName})` : '0';
  const isRoot = c.parentSpanId ? `${c.parentSpanId} = ''` : null;

  const rootServiceSel = !c.serviceName
    ? `'' AS rootServiceName`
    : isRoot && c.timestamp
    ? `if(countIf(${isRoot}) > 0, argMinIf(${c.serviceName}, ${c.timestamp}, ${isRoot}), argMin(${c.serviceName}, ${c.timestamp})) AS rootServiceName`
    : `any(${c.serviceName}) AS rootServiceName`;
  const rootOperationSel = !c.spanName
    ? `'' AS rootOperationName`
    : isRoot && c.timestamp
    ? `if(countIf(${isRoot}) > 0, argMinIf(${c.spanName}, ${c.timestamp}, ${isRoot}), argMin(${c.spanName}, ${c.timestamp})) AS rootOperationName`
    : `any(${c.spanName}) AS rootOperationName`;

  // Compute start/end/duration entirely in nanoseconds server-side, then convert to epoch-ms
  // client-side exactly once (see SpanRow/TraceRow doc comments in types.ts). Timestamp is assumed
  // DateTime64(9) per the OTel exporter schema, so toUnixTimestamp64Nano is always valid here.
  const startNsSel = c.timestamp ? `toUnixTimestamp64Nano(min(${c.timestamp})) AS startNs` : `0 AS startNs`;
  const endNsSel =
    c.timestamp && c.duration
      ? `max(toUnixTimestamp64Nano(${c.timestamp}) + ${c.duration}) AS endNs`
      : c.timestamp
      ? `toUnixTimestamp64Nano(max(${c.timestamp})) AS endNs`
      : `0 AS endNs`;

  const sortCol = sort.col === 'duration' ? 'durationNs' : 'startNs';

  return [
    `SELECT`,
    `  ${c.traceId} AS traceId,`,
    `  ${startNsSel},`,
    `  ${endNsSel},`,
    `  ${rootServiceSel},`,
    `  ${rootOperationSel},`,
    `  count() AS spanCount,`,
    `  ${errorCountExpr} AS errorCount,`,
    `  ${serviceCountExpr} AS serviceCount,`,
    `  (endNs - startNs) AS durationNs`,
    `FROM ${tbl}`,
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : null,
    `GROUP BY traceId`,
    `ORDER BY ${sortCol} ${sort.dir.toUpperCase()}`,
    `LIMIT ${pagination.limit} OFFSET ${pagination.offset}`,
  ].filter(Boolean).join('\n');
}

export interface TraceDetailOpts {
  /** Hard cap on spans returned; the caller shows a "trace truncated" notice when hit. */
  limit?: number;
  /**
   * Use the `<tracesTable>_trace_id_ts` materialized view (created by the standard ClickHouse
   * OTel exporter) to bound the main table scan to the trace's own [Start, End] window instead of
   * a full-table `WHERE TraceId = ...` scan. Falls back to a plain scan (still LIMIT-bounded) when
   * the MV doesn't exist in a given deployment — callers should retry with this set to false if
   * the indexed query errors (e.g. "table doesn't exist").
   */
  useTraceIdIndex?: boolean;
}

const DEFAULT_TRACE_DETAIL_LIMIT = 10_000;

export function buildTraceDetailQuery(
  config: SourceConfig,
  traceId: string,
  opts: TraceDetailOpts = {}
): string {
  const c = config.columns;
  // No traceId mapped → no trace concept at all; same gating style as buildLogsByTraceIdQuery.
  if (!c.traceId) {
    return '';
  }
  const limit = opts.limit ?? DEFAULT_TRACE_DETAIL_LIMIT;
  const useIndex = opts.useTraceIdIndex ?? true;
  const tbl = tableRef(config, config.tracesTable);
  const quotedId = quoteString(traceId);

  const spanAttrSel = c.spanAttributes ? `${c.spanAttributes} AS attributes` : `map() AS attributes`;
  const resourceAttrSel = c.resourceAttributes
    ? `${c.resourceAttributes} AS resourceAttributes`
    : `map() AS resourceAttributes`;
  const spanIdSel = c.spanId ? `${c.spanId} AS spanId` : `'' AS spanId`;
  const parentSpanIdSel = c.parentSpanId ? `${c.parentSpanId} AS parentSpanId` : `'' AS parentSpanId`;
  const serviceNameSel = c.serviceName ? `${c.serviceName} AS serviceName` : `'' AS serviceName`;
  const spanNameSel = c.spanName ? `${c.spanName} AS operationName` : `'' AS operationName`;
  const spanKindSel = c.spanKind ? `${c.spanKind} AS spanKind` : `'' AS spanKind`;
  const statusCodeSel = c.statusCode ? `${c.statusCode} AS statusCode` : `'' AS statusCode`;
  const statusMessageSel = c.statusMessage ? `${c.statusMessage} AS statusMessage` : `'' AS statusMessage`;
  // Same ns-precision rationale as buildTraceListQuery: compute nanosecond epoch server-side once,
  // convert to ms client-side once — never mix units in between.
  const startNsSel = c.timestamp ? `toUnixTimestamp64Nano(${c.timestamp}) AS startNs` : `0 AS startNs`;
  const durationSel = c.duration ? `${c.duration} AS durationNs` : `0 AS durationNs`;

  // Events.*/Links.* are fixed OTel exporter columns (not user-mapped) — see OTEL_STATUS_ERROR comment.
  // Events.Timestamp is converted to numeric nanosecond-epoch server-side (same as startNs) so the
  // client never has to guess how the datasource serializes a nested Array(DateTime64) column.
  const eventsSel = `arrayMap(x -> toUnixTimestamp64Nano(x), Events.Timestamp) AS eventsTimestamp, Events.Name AS eventsName, Events.Attributes AS eventsAttributes`;
  const linksSel = `Links.TraceId AS linksTraceId, Links.SpanId AS linksSpanId, Links.Attributes AS linksAttributes`;

  const traceIdTsTable = tableRef(config, `${config.tracesTable}_trace_id_ts`);
  // Bounding the scan by [Start, End] is meaningless without a mapped timestamp column to compare
  // against — skip it rather than emit a comparison against an empty column reference.
  //
  // The standard ClickHouse OTel exporter schema stores Start/End as second-precision `DateTime`
  // even though they're computed via min/max(Timestamp) over a DateTime64(9) column — the insert
  // silently truncates to the start of that second. `Timestamp <= End` would then wrongly exclude
  // any span landing after :00 within that final second (i.e. almost every real span, since
  // sub-second timestamps are the norm). Padding the upper bound by one second keeps the scan
  // bounded — still far cheaper than a full-table scan — without losing spans to the truncation.
  const boundsCondition = useIndex && c.timestamp
    ? [
        `${c.timestamp} >= (SELECT min(Start) FROM ${traceIdTsTable} WHERE TraceId = ${quotedId})`,
        `${c.timestamp} <= (SELECT max(End) FROM ${traceIdTsTable} WHERE TraceId = ${quotedId}) + INTERVAL 1 SECOND`,
      ]
    : [];

  return [
    `SELECT`,
    `  ${c.traceId} AS traceId,`,
    `  ${spanIdSel},`,
    `  ${parentSpanIdSel},`,
    `  ${serviceNameSel},`,
    `  ${spanNameSel},`,
    `  ${spanKindSel},`,
    `  ${startNsSel},`,
    `  ${durationSel},`,
    `  ${statusCodeSel},`,
    `  ${statusMessageSel},`,
    `  ${spanAttrSel},`,
    `  ${resourceAttrSel},`,
    `  ${eventsSel},`,
    `  ${linksSel}`,
    `FROM ${tbl}`,
    [`WHERE ${c.traceId} = ${quotedId}`, ...boundsCondition].join(' AND '),
    `ORDER BY startNs ASC`,
    `LIMIT ${limit}`,
  ].join('\n');
}

export function buildLogsByTraceIdQuery(config: SourceConfig, traceId: string): string {
  const c = config.columns;
  const tbl = tableRef(config, config.logsTable);
  if (!c.traceId || !c.timestamp || !c.body) {
    return '';
  }
  return [
    `SELECT ${c.timestamp} AS timestamp, ${c.body} AS body, ${c.severity || "''"} AS severity`,
    `FROM ${tbl}`,
    `WHERE ${c.traceId} = ${quoteString(traceId)}`,
    `ORDER BY timestamp ASC`,
    `LIMIT 500`,
  ].join('\n');
}

/** Trace-list histogram: same bucketing/breakdown shape as buildVolumeQuery, over the traces table. */
export function buildTraceVolumeQuery(
  config: SourceConfig,
  filters: TraceListFilters,
  opts: VolumeQueryOpts
): string {
  const c = config.columns;
  if (!c.timestamp) {
    return '';
  }
  const tbl = tableRef(config, config.tracesTable);
  const { interval, breakdown } = opts;
  const timeExpr = 'macro' in interval
    ? `$__timeInterval(${c.timestamp})`
    : `toStartOfInterval(${c.timestamp}, INTERVAL ${interval.value} ${interval.unit})`;
  const conditions = buildTraceWhereConditions(config, filters);
  const condSql = conditions.join(' AND ');
  const whereSql = condSql ? `WHERE ${condSql}` : '';

  if (breakdown.kind === 'none') {
    return [
      `SELECT ${timeExpr} AS time, '' AS level, count() AS count`,
      `FROM ${tbl}`,
      whereSql || null,
      `GROUP BY time, level`,
      `ORDER BY time ASC`,
    ].filter(Boolean).join('\n');
  }

  if (breakdown.kind === 'severity') {
    // Reused for "status" breakdown on traces (breakdown.expr = statusCode column) — the kind name
    // is generic in VolumeBreakdown, only the expr differs from the logs severity case.
    return [
      `SELECT ${timeExpr} AS time, lower(toString(${breakdown.expr})) AS level, count() AS count`,
      `FROM ${tbl}`,
      whereSql || null,
      `GROUP BY time, level`,
      `ORDER BY time ASC`,
    ].filter(Boolean).join('\n');
  }

  const limit = breakdown.limit ?? 10;
  const exprStr = `toString(${breakdown.expr})`;
  return [
    `WITH top AS (`,
    `  SELECT ${exprStr} AS v`,
    `  FROM ${tbl}`,
    whereSql ? `  ${whereSql}` : null,
    `  GROUP BY v ORDER BY count() DESC LIMIT ${limit}`,
    `)`,
    `SELECT ${timeExpr} AS time,`,
    `       if(${exprStr} GLOBAL IN (SELECT v FROM top), ${exprStr}, 'Other') AS level,`,
    `       count() AS count`,
    `FROM ${tbl}`,
    whereSql || null,
    `GROUP BY time, level`,
    `ORDER BY time ASC`,
  ].filter(Boolean).join('\n');
}
