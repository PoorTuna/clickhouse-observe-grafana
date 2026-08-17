/**
 * OTel schema presets and detection helpers.
 * Adapted from grafana/clickhouse-datasource src/otel.ts (Apache-2.0).
 */

import { ColumnMapping, SourceConfig, OTEL_COLUMN_MAPPING } from '../types';
import { quoteDottedPath, quoteString } from './queryBuilder';

export const OTEL_LOGS_TABLE = 'otel_logs';

/** Auto-fill OTel column preset onto a SourceConfig. */
export function applyOtelPreset(config: SourceConfig): SourceConfig {
  return {
    ...config,
    logsTable: OTEL_LOGS_TABLE,
    isOtel: true,
    columns: { ...OTEL_COLUMN_MAPPING },
  };
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
 * Group attribute-container columns (Map or JSON) into flattened dotted-path rows for the detail
 * drawer. `mapColumns`/`jsonColumns` are discovered column names (field discovery — auto for
 * both types now, no config mapping required) rather than a fixed OTel-category list: Resource/
 * Log/Scope Attributes used to be 3 explicitly-mapped fields, but any Map-typed column is treated
 * the same way now, matching how JSON columns already worked. `columns.spanAttributes` stays
 * config-driven and is folded in alongside if mapped.
 */
export function groupAttributes(
  row: Record<string, unknown>,
  columns: ColumnMapping,
  mapColumns: Set<string>,
  jsonColumns?: Set<string>
): Array<{ col: string; rows: GroupedAttrRow[] }> {
  const cols = new Set<string>([...mapColumns, ...(jsonColumns ?? [])]);
  if (columns.spanAttributes) {
    cols.add(columns.spanAttributes);
  }

  return Array.from(cols)
    .map((col) => {
      const rawValue = row[col] ?? row[col.split('[')[0]];
      let rows: GroupedAttrRow[];
      if (jsonColumns?.has(col)) {
        rows = flattenJson(parseJsonColumnValue(rawValue)).map(({ key, value }) => ({
          key,
          value,
          // quoteDottedPath() — shared with FieldsContext.tsx's discovery-derived fields and
          // rowFields.ts's deriveAttributeFields() — so a path with a non-bare-identifier segment
          // (e.g. `user-id`) produces the same sqlExpr regardless of which of the three built it
          // (see item 6 in the perf plan).
          sqlExpr: quoteDottedPath(col, key),
        }));
      } else {
        rows = Object.entries(parseMapValue(rawValue)).map(([key, value]) => ({
          key,
          value,
          // quoteString() — same reasoning as above, for Map keys: a key containing `'` must
          // produce one expression, not a raw-spliced one that diverges from discovery's.
          sqlExpr: `${col}[${quoteString(key)}]`,
        }));
      }
      return { col, rows };
    })
    .filter((g) => g.rows.length > 0);
}
