/**
 * ClickHouse SQL generation for logs, volume, and trace queries.
 * Adapted from grafana/clickhouse-datasource src/data/sqlGenerator.ts (Apache-2.0).
 *
 * Uses $__fromTime / $__toTime macros — the CH datasource backend expands these
 * from the query request's time range automatically.
 */

import { FilterPill, FilterOp, LogsQueryState, SourceConfig } from '../types';
import { resolveField, buildLevelClause } from './fields';

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
  }
}

function buildFilterClause(filter: FilterPill, config: SourceConfig): string {
  const value = filter.value.trim();
  const resolved = resolveField(filter.field, config);
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

  const c = config.columns;

  const colonMatch = /^([A-Za-z_][A-Za-z0-9_.[\]']*):(.+)$/.exec(term);
  if (colonMatch) {
    const [, rawField, rawValue] = colonMatch;
    const value = rawValue.trim();
    const resolved = resolveField(rawField, config);

    if (resolved === null) {
      return `${c.body} ILIKE ${quoteString('%' + value + '%')}`;
    }
    const { sqlExpr, kind } = resolved;
    if (kind === 'level') {
      return buildLevelClause(sqlExpr, value, false);
    }
    if (kind === 'text') {
      return `${sqlExpr} ILIKE ${quoteString('%' + value + '%')}`;
    }
    return `${quoteIdentifier(sqlExpr)} = ${quoteString(value)}`;
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
  const conditions: string[] = [
    `${config.columns.timestamp} >= $__fromTime AND ${config.columns.timestamp} <= $__toTime`,
  ];
  if (state.search.trim()) {
    conditions.push(buildSearchClause(state.search, config));
  }
  for (const f of state.filters) {
    conditions.push(buildFilterClause(f, config));
  }
  return conditions;
}

export function buildLogsQuery(config: SourceConfig, state: LogsQueryState): string {
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
    `LIMIT ${state.limit}`,
  ].join('\n');
}

export function buildVolumeQuery(
  config: SourceConfig,
  state: LogsQueryState,
  intervalSeconds?: number
): string {
  const c = config.columns;
  const tbl = tableRef(config, config.logsTable);
  const sevCol = c.severity || `''`;
  const timeExpr = intervalSeconds
    ? `toStartOfInterval(${c.timestamp}, INTERVAL ${intervalSeconds} SECOND)`
    : `toStartOfMinute(${c.timestamp})`;

  const conditions = buildWhereConditions(config, state);

  return [
    `SELECT ${timeExpr} AS time, ${sevCol} AS level, count() AS count`,
    `FROM ${tbl}`,
    `WHERE ${conditions.join(' AND ')}`,
    `GROUP BY time, level`,
    `ORDER BY time ASC`,
  ].join('\n');
}

export function buildFieldTopValuesQuery(
  config: SourceConfig,
  state: LogsQueryState,
  sqlExpr: string,
  limit = 10
): string {
  const tbl = tableRef(config, config.logsTable);
  const conditions = buildWhereConditions(config, state);

  return [
    `SELECT toString(${sqlExpr}) AS value, count() AS count`,
    `FROM ${tbl}`,
    `WHERE ${conditions.join(' AND ')} AND notEmpty(toString(${sqlExpr}))`,
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
