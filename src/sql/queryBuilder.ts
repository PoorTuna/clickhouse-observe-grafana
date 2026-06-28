/**
 * ClickHouse SQL generation for logs, volume, and trace queries.
 * Adapted from grafana/clickhouse-datasource src/data/sqlGenerator.ts (Apache-2.0).
 *
 * Uses $__fromTime / $__toTime macros — the CH datasource backend expands these
 * from the query request's time range automatically.
 */

import { FilterPill, FilterOp, LogsQueryState, SourceConfig } from '../types';

// Severity level aliases adapted from CH datasource src/data/logs.ts
export const LOG_LEVEL_TO_IN_CLAUSE: Record<string, string> = (() => {
  const levels: Record<string, string[]> = {
    critical: ['critical', 'fatal', 'crit', 'alert', 'emerg'],
    error: ['error', 'err', 'eror'],
    warn: ['warn', 'warning'],
    info: ['info', 'information', 'informational'],
    debug: ['debug', 'dbug'],
    trace: ['trace'],
    unknown: ['unknown'],
  };
  return Object.fromEntries(
    Object.entries(levels).map(([level, aliases]) => [
      level,
      [
        ...aliases.map((a) => `'${a}'`),
        ...aliases.map((a) => `'${a.toUpperCase()}'`),
        ...aliases.map((a) => `'${a[0].toUpperCase()}${a.slice(1)}'`),
      ].join(','),
    ])
  );
})();

function quoteIdentifier(name: string): string {
  // If it's a Map access like ResourceAttributes['key'] or a function call, don't quote
  if (name.includes('[') || name.includes('(') || name.includes('.')) {
    return name;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
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

function buildFilterClause(filter: FilterPill): string {
  const col = quoteIdentifier(filter.field);
  const op = filterOpToSql(filter.op);
  if (op === 'ILIKE' || op === 'NOT ILIKE') {
    return `${col} ${op} ${quoteString('%' + filter.value + '%')}`;
  }
  return `${col} ${op} ${quoteString(filter.value)}`;
}

function buildSearchClause(search: string, bodyCol: string): string {
  const term = search.trim();
  if (!term) {
    return '';
  }

  // `field:value` or `field=value` shorthand → typed predicate
  const colonMatch = /^([A-Za-z_][A-Za-z0-9_.[\]']*):(.+)$/.exec(term);
  if (colonMatch) {
    const [, field, value] = colonMatch;
    return `${quoteIdentifier(field)} = ${quoteString(value)}`;
  }

  // Free text: hasToken for token-BF indexed columns + ILIKE fallback
  const quoted = quoteString(term);
  return `(hasToken(${bodyCol}, ${quoted}) OR ${bodyCol} ILIKE ${quoteString('%' + term + '%')})`;
}

function tableRef(config: SourceConfig, table: string): string {
  return `"${config.database}"."${table}"`;
}

// ---------------------------------------------------------------------------
// Public builders
// ---------------------------------------------------------------------------

export function buildLogsQuery(config: SourceConfig, state: LogsQueryState): string {
  const c = config.columns;
  const tbl = tableRef(config, config.logsTable);

  const selectParts = [
    `${c.timestamp} AS timestamp`,
    `${c.body} AS body`,
    c.severity ? `${c.severity} AS severity` : `'' AS severity`,
    c.traceId ? `${c.traceId} AS traceId` : `'' AS traceId`,
    c.spanId ? `${c.spanId} AS spanId` : `'' AS spanId`,
    c.serviceName ? `${c.serviceName} AS serviceName` : `'' AS serviceName`,
    c.resourceAttributes ? `${c.resourceAttributes} AS ResourceAttributes` : null,
    c.logAttributes ? `${c.logAttributes} AS LogAttributes` : null,
    c.scopeAttributes ? `${c.scopeAttributes} AS ScopeAttributes` : null,
  ].filter(Boolean);

  const conditions: string[] = [`${c.timestamp} >= $__fromTime AND ${c.timestamp} <= $__toTime`];

  if (state.search.trim()) {
    conditions.push(buildSearchClause(state.search, c.body));
  }
  for (const f of state.filters) {
    conditions.push(buildFilterClause(f));
  }

  return [
    `SELECT ${selectParts.join(', ')}`,
    `FROM ${tbl}`,
    `WHERE ${conditions.join(' AND ')}`,
    `ORDER BY timestamp DESC`,
    `LIMIT ${state.limit}`,
  ].join('\n');
}

export function buildVolumeQuery(config: SourceConfig, state: LogsQueryState): string {
  const c = config.columns;
  const tbl = tableRef(config, config.logsTable);
  const sevCol = c.severity || `''`;

  const conditions: string[] = [`${c.timestamp} >= $__fromTime AND ${c.timestamp} <= $__toTime`];
  if (state.search.trim()) {
    conditions.push(buildSearchClause(state.search, c.body));
  }
  for (const f of state.filters) {
    conditions.push(buildFilterClause(f));
  }

  return [
    `SELECT toStartOfMinute(${c.timestamp}) AS time, ${sevCol} AS level, count() AS count`,
    `FROM ${tbl}`,
    `WHERE ${conditions.join(' AND ')}`,
    `GROUP BY time, level`,
    `ORDER BY time ASC`,
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
    conditions.push(`${c.serviceName} ILIKE ${quoteString('%' + search + '%')}`);
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
