import { SourceConfig } from '../types';

export type FieldKind = 'text' | 'exact' | 'level' | 'map';

export interface ResolvedField {
  sqlExpr: string;
  kind: FieldKind;
}

// Level aliases → IN/NOT IN expansion. Adapted from grafana/clickhouse-datasource (Apache-2.0).
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

export function buildLevelClause(expr: string, value: string, negate: boolean): string {
  const normalized = value.trim().toLowerCase();
  const inList = LOG_LEVEL_TO_IN_CLAUSE[normalized];
  if (inList) {
    return `${expr} ${negate ? 'NOT IN' : 'IN'} (${inList})`;
  }
  // Unknown level — fall back to ILIKE (escape ILIKE metacharacters so value is literal)
  const escaped = value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_').replace(/'/g, "\\'");
  return `${expr} ${negate ? 'NOT ILIKE' : 'ILIKE'} '${escaped}'`;
}

/**
 * Resolve a user-typed field name to a SQL expression + kind.
 * Returns null for unknown fields → callers fall back to free-text body search.
 */
export function resolveField(rawField: string, config: SourceConfig): ResolvedField | null {
  const f = rawField.trim().toLowerCase();
  const c = config.columns;

  // Body / message aliases
  if (['message', 'msg', 'body', 'log', 'text', 'content'].includes(f)) {
    if (!c.body) {
      return null; // body column not mapped; toSql falls back to treating field name as direct column
    }
    return { sqlExpr: c.body, kind: 'text' };
  }

  // Level / severity aliases — only when severity is mapped; otherwise fall through to body search
  if (['level', 'severity', 'lvl', 'loglevel', 'log_level', 'severitytext'].includes(f)) {
    if (!c.severity) {
      return null;
    }
    return { sqlExpr: c.severity, kind: 'level' };
  }

  // SeverityNumber — only resolve to hardcoded OTel column name on OTel schemas;
  // on arbitrary schemas, fall through so toSql uses the field name directly.
  if (['severitynumber', 'severity_number'].includes(f)) {
    if (!config.isOtel) {
      return null;
    }
    return { sqlExpr: 'SeverityNumber', kind: 'exact' };
  }

  // Service name aliases — only when mapped
  if (['service', 'svc', 'service.name', 'servicename', 'service_name'].includes(f)) {
    if (!c.serviceName) {
      return null;
    }
    return { sqlExpr: c.serviceName, kind: 'exact' };
  }

  // Trace ID aliases — only when mapped
  if (['trace', 'traceid', 'trace_id', 'trace.id'].includes(f)) {
    if (!c.traceId) {
      return null;
    }
    return { sqlExpr: c.traceId, kind: 'exact' };
  }

  // Span ID aliases — only when mapped
  if (['span', 'spanid', 'span_id', 'span.id'].includes(f)) {
    if (!c.spanId) {
      return null;
    }
    return { sqlExpr: c.spanId, kind: 'exact' };
  }

  // Direct column mapping match (case-insensitive)
  for (const [, colExpr] of Object.entries(c)) {
    if (typeof colExpr === 'string' && colExpr.toLowerCase() === f) {
      return { sqlExpr: colExpr, kind: 'exact' };
    }
  }

  // Already a Map accessor like ResourceAttributes['key'] or a function call — pass through
  const raw = rawField.trim();
  if (raw.includes('[') || raw.includes('(')) {
    return { sqlExpr: raw, kind: raw.includes('[') ? 'map' : 'exact' };
  }

  // Dotted key → Map attribute lookup (logAttributes preferred, then resourceAttributes)
  const mapCol = c.logAttributes || c.resourceAttributes;
  if (mapCol && rawField.includes('.')) {
    return { sqlExpr: `${mapCol}['${rawField}']`, kind: 'map' };
  }

  // Single-word unknown → try logAttributes Map access if available
  if (mapCol) {
    return { sqlExpr: `${mapCol}['${rawField}']`, kind: 'map' };
  }

  return null;
}
