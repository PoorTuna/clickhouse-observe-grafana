/**
 * ClickHouse SQL generation for logs, volume, and trace queries.
 * Adapted from grafana/clickhouse-datasource src/data/sqlGenerator.ts (Apache-2.0).
 *
 * Uses $__fromTime / $__toTime macros — the CH datasource backend expands these
 * from the query request's time range automatically.
 */

import { FilterPill, FilterOp, LogsQueryState, SourceConfig } from '../types';
import { resolveField, buildLevelClause } from './fields';
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
    const bodyCol = config.columns.body;
    return negate
      ? `${bodyCol} NOT ILIKE ${quoteString('%' + value + '%')}`
      : `${bodyCol} ILIKE ${quoteString('%' + value + '%')}`;
  }

  const { sqlExpr, kind } = resolved;

  if (kind === 'level') {
    return buildLevelClause(sqlExpr, value, negate);
  }

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

  // Core SELECT — always present; drawer + trace-link depend on these fixed aliases.
  const coreSelect = [
    `${c.timestamp} AS timestamp`,
    `${c.body} AS body`,
    c.severity ? `${c.severity} AS severity` : `'' AS severity`,
    c.traceId ? `${c.traceId} AS traceId` : `'' AS traceId`,
    c.spanId ? `${c.spanId} AS spanId` : `'' AS spanId`,
    c.serviceName ? `${c.serviceName} AS serviceName` : `'' AS serviceName`,
    c.resourceAttributes ? `${c.resourceAttributes} AS ResourceAttributes` : null,
    c.logAttributes ? `${c.logAttributes} AS LogAttributes` : null,
    c.scopeAttributes ? `${c.scopeAttributes} AS ScopeAttributes` : null,
  ].filter(Boolean) as string[];

  // Extra SELECT for user-added non-core columns
  const extraSelect = (state.columns ?? [])
    .filter((col) => !col.isCore)
    .map((col) => `${col.sqlExpr} AS ${col.key}`);

  const selectParts = [...coreSelect, ...extraSelect];
  const conditions = buildWhereConditions(config, state);

  const sortCol = state.sort?.col ?? 'timestamp';
  const sortDir = (state.sort?.dir ?? 'desc').toUpperCase();

  return [
    `SELECT ${selectParts.join(', ')}`,
    `FROM ${tbl}`,
    `WHERE ${conditions.join(' AND ')}`,
    `ORDER BY ${sortCol} ${sortDir}`,
    pagination
      ? `LIMIT ${pagination.limit} OFFSET ${pagination.offset}`
      : `LIMIT ${state.limit}`,
  ].join('\n');
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
  interval: { unit: CHIntervalUnit; value: number };
  breakdown: VolumeBreakdown;
}

export function buildVolumeQuery(
  config: SourceConfig,
  state: LogsQueryState,
  opts: VolumeQueryOpts
): string {
  const c = config.columns;
  const tbl = tableRef(config, config.logsTable);
  const { interval, breakdown } = opts;
  const timeExpr = `toStartOfInterval(${c.timestamp}, INTERVAL ${interval.value} ${interval.unit})`;
  const conditions = buildWhereConditions(config, state);
  const condSql = conditions.join(' AND ');

  if (breakdown.kind === 'none') {
    // Single series: constant empty-string level so the fold loop stays generic.
    return [
      `SELECT ${timeExpr} AS time, '' AS level, count() AS count`,
      `FROM ${tbl}`,
      `WHERE ${condSql}`,
      `GROUP BY time, level`,
      `ORDER BY time ASC`,
    ].join('\n');
  }

  if (breakdown.kind === 'severity') {
    // Stack by severity column — no CTE, identical to the original behaviour.
    return [
      `SELECT ${timeExpr} AS time, ${breakdown.expr} AS level, count() AS count`,
      `FROM ${tbl}`,
      `WHERE ${condSql}`,
      `GROUP BY time, level`,
      `ORDER BY time ASC`,
    ].join('\n');
  }

  // Field breakdown: compute top-N server-side so 'Other' is one aggregated series.
  const limit = breakdown.limit ?? 10;
  const exprStr = `toString(${breakdown.expr})`;
  return [
    `WITH top AS (`,
    `  SELECT ${exprStr} AS v`,
    `  FROM ${tbl}`,
    `  WHERE ${condSql}`,
    `  GROUP BY v ORDER BY count() DESC LIMIT ${limit}`,
    `)`,
    `SELECT ${timeExpr} AS time,`,
    `       if(${exprStr} IN (SELECT v FROM top), ${exprStr}, 'Other') AS level,`,
    `       count() AS count`,
    `FROM ${tbl}`,
    `WHERE ${condSql}`,
    `GROUP BY time, level`,
    `ORDER BY time ASC`,
  ].join('\n');
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
  return [
    `WITH sample AS (`,
    `  SELECT toString(${sqlExpr}) AS value`,
    `  FROM ${tbl}`,
    `  WHERE ${conditions.join(' AND ')}`,
    `  ORDER BY ${tsCol} DESC`,
    `  LIMIT ${sampleSize}`,
    `)`,
    `SELECT value, count() AS count, (SELECT count() FROM sample) AS total`,
    `FROM sample`,
    `WHERE notEmpty(value)`,
    `GROUP BY value`,
    `ORDER BY count DESC`,
    `LIMIT ${limit}`,
  ].join('\n');
}

export function buildSurroundingDocsQuery(
  config: SourceConfig,
  rowTimestamp: string,
  n = 25,
  direction: 'before' | 'after' = 'before'
): string {
  const c = config.columns;
  const tbl = tableRef(config, config.logsTable);
  const op = direction === 'before' ? '<' : '>';
  const order = direction === 'before' ? 'DESC' : 'ASC';

  return [
    `SELECT ${c.timestamp} AS timestamp, ${c.body} AS body,`,
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
  const tbl = tableRef(config, config.tracesTable);

  const conditions: string[] = [`${c.timestamp} >= $__fromTime AND ${c.timestamp} <= $__toTime`];
  if (search.trim()) {
    conditions.push(`${c.serviceName} ILIKE ${quoteString('%' + search.trim() + '%')}`);
  }

  return [
    `SELECT`,
    `  ${c.traceId} AS traceId,`,
    `  min(${c.timestamp}) AS startTime,`,
    `  max(${c.timestamp}) AS endTime,`,
    `  ${c.serviceName} AS serviceName,`,
    `  count() AS spanCount,`,
    `  countIf(StatusCode = 'STATUS_CODE_ERROR') AS errorCount,`,
    `  max(${c.duration}) AS durationNs`,
    `FROM ${tbl}`,
    `WHERE ${conditions.join(' AND ')}`,
    `GROUP BY traceId, serviceName`,
    `ORDER BY startTime DESC`,
    `LIMIT ${limit}`,
  ].join('\n');
}

export function buildTraceDetailQuery(config: SourceConfig, traceId: string): string {
  const c = config.columns;
  const tbl = tableRef(config, config.tracesTable);
  const spanAttrSel = c.spanAttributes ? `${c.spanAttributes} AS tags` : `'' AS tags`;

  return [
    `SELECT`,
    `  ${c.traceId} AS traceID,`,
    `  SpanId AS spanID,`,
    `  ${c.parentSpanId} AS parentSpanID,`,
    `  ${c.serviceName} AS serviceName,`,
    `  SpanName AS operationName,`,
    `  ${c.timestamp} AS startTime,`,
    `  ${c.duration} AS durationNs,`,
    `  StatusCode AS statusCode,`,
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
