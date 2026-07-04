/**
 * ClickHouse SQL generation for logs, volume, and trace queries.
 * Adapted from grafana/clickhouse-datasource src/data/sqlGenerator.ts (Apache-2.0).
 *
 * Uses $__fromTime / $__toTime macros — the CH datasource backend expands these
 * from the query request's time range automatically.
 */

import { BreakdownSel, FilterPill, FilterOp, LogsQueryState, SourceConfig } from '../types';
import { resolveField } from './fields';
import { parseKql, kqlToSql } from './kql';

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

function buildSearchClause(search: string, config: SourceConfig): string {
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

  // Core aliases for mapped columns only — omitted entirely when unmapped (not a constant
  // '' fallback) so an arbitrary table's own same-named column, exposed via '*', never collides
  // with a phantom empty column of the same alias. Consumers already treat an absent key the
  // same as an empty one (falsy checks throughout), so dropping the column changes nothing
  // downstream.
  const coreSelect = [
    c.timestamp ? `${c.timestamp} AS timestamp` : null,
    c.body ? `${c.body} AS body` : null,
    c.severity ? `${c.severity} AS severity` : null,
    c.traceId ? `${c.traceId} AS traceId` : null,
    c.spanId ? `${c.spanId} AS spanId` : null,
    c.serviceName ? `${c.serviceName} AS serviceName` : null,
    c.resourceAttributes ? `${c.resourceAttributes} AS ResourceAttributes` : null,
    c.logAttributes ? `${c.logAttributes} AS LogAttributes` : null,
    c.scopeAttributes ? `${c.scopeAttributes} AS ScopeAttributes` : null,
  ].filter(Boolean) as string[];

  // Extra SELECT for user-added non-core columns
  const extraSelect = (state.columns ?? [])
    .filter((col) => !col.isCore)
    .map((col) => `${col.sqlExpr} AS ${col.key}`);

  const selectParts = ['*', ...coreSelect, ...extraSelect];
  const conditions = buildWhereConditions(config, state);

  const sortCol = state.sort?.col ?? (c.timestamp ? 'timestamp' : null);
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
      return { kind: 'severity', expr: config.columns.severity };
    case 'field':
      return { kind: 'field', expr: breakdown.field.sqlExpr };
  }
}

export function buildFieldTopValuesQuery(
  config: SourceConfig,
  state: LogsQueryState,
  sqlExpr: string,
  limit = 10,
  sampleSize = 500
): string {
  const tbl = tableRef(config, config.logsTable);
  const conditions = buildWhereConditions(config, state);
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

export function buildTraceSearchQuery(
  config: SourceConfig,
  search: string,
  limit = 100
): string {
  const c = config.columns;
  // No traceId mapped → no trace concept at all; same gating style as buildLogsByTraceIdQuery.
  if (!c.traceId) {
    return '';
  }
  const tbl = tableRef(config, config.tracesTable);

  const conditions: string[] = [];
  if (c.timestamp) {
    conditions.push(`${c.timestamp} >= $__fromTime AND ${c.timestamp} <= $__toTime`);
  }
  if (search.trim() && c.serviceName) {
    conditions.push(`${c.serviceName} ILIKE ${quoteString('%' + search.trim() + '%')}`);
  }

  // 'STATUS_CODE_ERROR' is the OTel span-status enum value — only meaningful
  // when the user has mapped a status code column in the first place.
  const errorCountExpr = c.statusCode ? `countIf(${c.statusCode} = 'STATUS_CODE_ERROR')` : '0';
  const serviceNameSel = c.serviceName ? `${c.serviceName} AS serviceName` : `'' AS serviceName`;
  const startTimeSel = c.timestamp ? `min(${c.timestamp}) AS startTime` : `0 AS startTime`;
  const endTimeSel = c.timestamp ? `max(${c.timestamp}) AS endTime` : `0 AS endTime`;
  const durationSel = c.duration ? `max(${c.duration}) AS durationNs` : `0 AS durationNs`;

  return [
    `SELECT`,
    `  ${c.traceId} AS traceId,`,
    `  ${startTimeSel},`,
    `  ${endTimeSel},`,
    `  ${serviceNameSel},`,
    `  count() AS spanCount,`,
    `  ${errorCountExpr} AS errorCount,`,
    `  ${durationSel}`,
    `FROM ${tbl}`,
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : null,
    // Constant selects (unmapped serviceName) don't need to appear in GROUP BY.
    `GROUP BY traceId${c.serviceName ? ', serviceName' : ''}`,
    `ORDER BY startTime DESC`,
    `LIMIT ${limit}`,
  ].filter(Boolean).join('\n');
}

export function buildTraceDetailQuery(config: SourceConfig, traceId: string): string {
  const c = config.columns;
  // No traceId mapped → no trace concept at all; same gating style as buildLogsByTraceIdQuery.
  if (!c.traceId) {
    return '';
  }
  const tbl = tableRef(config, config.tracesTable);
  const spanAttrSel = c.spanAttributes ? `${c.spanAttributes} AS tags` : `'' AS tags`;
  const spanIdSel = c.spanId ? `${c.spanId} AS spanID` : `'' AS spanID`;
  const parentSpanIdSel = c.parentSpanId ? `${c.parentSpanId} AS parentSpanID` : `'' AS parentSpanID`;
  const serviceNameSel = c.serviceName ? `${c.serviceName} AS serviceName` : `'' AS serviceName`;
  const spanNameSel = c.spanName ? `${c.spanName} AS operationName` : `'' AS operationName`;
  const statusCodeSel = c.statusCode ? `${c.statusCode} AS statusCode` : `'' AS statusCode`;
  const startTimeSel = c.timestamp ? `${c.timestamp} AS startTime` : `0 AS startTime`;
  const durationSel = c.duration ? `${c.duration} AS durationNs` : `0 AS durationNs`;

  return [
    `SELECT`,
    `  ${c.traceId} AS traceID,`,
    `  ${spanIdSel},`,
    `  ${parentSpanIdSel},`,
    `  ${serviceNameSel},`,
    `  ${spanNameSel},`,
    `  ${startTimeSel},`,
    `  ${durationSel},`,
    `  ${statusCodeSel},`,
    `  ${spanAttrSel}`,
    `FROM ${tbl}`,
    `WHERE ${c.traceId} = ${quoteString(traceId)}`,
    `ORDER BY startTime ASC`,
  ].join('\n');
}

export function buildLogsByTraceIdQuery(config: SourceConfig, traceId: string): string {
  const c = config.columns;
  const tbl = tableRef(config, config.logsTable);
  if (!c.traceId) {
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
