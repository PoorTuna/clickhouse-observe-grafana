/**
 * OTel schema presets and detection helpers.
 * Adapted from grafana/clickhouse-datasource src/otel.ts (Apache-2.0).
 */

import { ColumnMapping, SourceConfig, OTEL_COLUMN_MAPPING } from '../types';

export const OTEL_LOGS_TABLE = 'otel_logs';
export const OTEL_TRACES_TABLE = 'otel_traces';

/** Auto-fill OTel column preset onto a SourceConfig. */
export function applyOtelPreset(config: SourceConfig): SourceConfig {
  return {
    ...config,
    logsTable: OTEL_LOGS_TABLE,
    tracesTable: OTEL_TRACES_TABLE,
    isOtel: true,
    columns: { ...OTEL_COLUMN_MAPPING },
  };
}

export type AttributeGroup = 'resource' | 'log' | 'scope' | 'span';

/** Return the Map column name for an attribute group, or '' if absent. */
export function getAttributeMapColumn(
  group: AttributeGroup,
  columns: ColumnMapping
): string {
  switch (group) {
    case 'resource':
      return columns.resourceAttributes;
    case 'log':
      return columns.logAttributes;
    case 'scope':
      return columns.scopeAttributes;
    case 'span':
      return columns.spanAttributes;
  }
}

/**
 * Parse a serialized ClickHouse Map value from the DataFrame.
 * The CH datasource returns Map columns as JSON-like strings or plain objects.
 */
/** Coerce a parsed map's values to strings — OTel attribute maps can hold nested
 * objects/arrays for some keys, but callers render every value as plain text. */
function stringifyValues(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
  }
  return out;
}

export function parseMapValue(raw: unknown): Record<string, string> {
  if (raw === null || raw === undefined) {
    return {};
  }
  if (typeof raw === 'object') {
    return stringifyValues(raw as Record<string, unknown>);
  }
  if (typeof raw === 'string') {
    if (!raw || raw === '{}') {
      return {};
    }
    try {
      return stringifyValues(JSON.parse(raw));
    } catch {
      // ClickHouse sometimes serializes Maps as {'key':'val','key2':'val2'}
      // with single quotes; attempt a liberal parse
      try {
        return stringifyValues(JSON.parse(raw.replace(/'/g, '"')));
      } catch {
        return {};
      }
    }
  }
  return {};
}

export interface GroupedAttrRow {
  key: string;
  value: string;
  /** SQL expression to use for filter/column-toggle actions on this row. */
  sqlExpr: string;
}

/**
 * Recursively flatten a JSON-typed column's parsed value into dotted-path leaves, mirroring the
 * accessor convention field discovery uses (FieldsContext.tsx's json fields: `${jsonCol}.${path}`)
 * so a row's sqlExpr always matches what discovery would have produced for the same path.
 * Arrays and primitives are treated as leaves (JSON.stringify'd if not already a string) — only
 * plain objects are recursed into.
 */
export function flattenJson(value: unknown, prefix = ''): Array<{ key: string; value: string }> {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    const out: Array<{ key: string; value: string }> = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.push(...flattenJson(v, path));
    }
    return out;
  }
  if (!prefix) {
    return [];
  }
  return [{ key: prefix, value: value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '') }];
}

/** Parse a JSON-typed column's raw DataFrame value (object or JSON string) into a plain object. */
export function parseJsonColumnValue(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) {
    return {};
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    if (!raw) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Group log attributes by OTel category for the detail drawer.
 * `jsonColumns` — names of columns known (from field discovery) to be native ClickHouse JSON type
 * rather than Map(String,String). When omitted, every attribute column is treated as Map — the
 * original behavior — so existing callers (and Map-schema views) are unaffected.
 */
export function groupAttributes(
  row: Record<string, unknown>,
  columns: ColumnMapping,
  jsonColumns?: Set<string>
): Array<{ group: AttributeGroup; label: string; col: string; rows: GroupedAttrRow[] }> {
  const groups: Array<{ group: AttributeGroup; label: string; col: string }> = [
    { group: 'resource', label: 'Resource Attributes', col: columns.resourceAttributes },
    { group: 'log', label: 'Log Attributes', col: columns.logAttributes },
    { group: 'scope', label: 'Scope Attributes', col: columns.scopeAttributes },
    { group: 'span', label: 'Span Attributes', col: columns.spanAttributes },
  ];

  return groups
    .filter((g) => g.col)
    .map((g) => {
      const rawValue = row[g.col] ?? row[g.col.split('[')[0]];
      let rows: GroupedAttrRow[];
      if (jsonColumns?.has(g.col)) {
        rows = flattenJson(parseJsonColumnValue(rawValue)).map(({ key, value }) => ({
          key,
          value,
          sqlExpr: `${g.col}.${key}`,
        }));
      } else {
        rows = Object.entries(parseMapValue(rawValue)).map(([key, value]) => ({
          key,
          value,
          sqlExpr: `${g.col}['${key}']`,
        }));
      }
      return { ...g, rows };
    })
    .filter((g) => g.rows.length > 0);
}
