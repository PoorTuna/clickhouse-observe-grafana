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
export function parseMapValue(raw: unknown): Record<string, string> {
  if (raw === null || raw === undefined) {
    return {};
  }
  if (typeof raw === 'object') {
    return raw as Record<string, string>;
  }
  if (typeof raw === 'string') {
    if (!raw || raw === '{}') {
      return {};
    }
    try {
      return JSON.parse(raw);
    } catch {
      // ClickHouse sometimes serializes Maps as {'key':'val','key2':'val2'}
      // with single quotes; attempt a liberal parse
      try {
        return JSON.parse(raw.replace(/'/g, '"'));
      } catch {
        return {};
      }
    }
  }
  return {};
}

/** Group log attributes by OTel category for the detail drawer. */
export function groupAttributes(
  row: Record<string, unknown>,
  columns: ColumnMapping
): Array<{ group: AttributeGroup; label: string; col: string; attrs: Record<string, string> }> {
  const groups: Array<{ group: AttributeGroup; label: string; col: string }> = [
    { group: 'resource', label: 'Resource Attributes', col: columns.resourceAttributes },
    { group: 'log', label: 'Log Attributes', col: columns.logAttributes },
    { group: 'scope', label: 'Scope Attributes', col: columns.scopeAttributes },
    { group: 'span', label: 'Span Attributes', col: columns.spanAttributes },
  ];

  return groups
    .filter((g) => g.col)
    .map((g) => ({
      ...g,
      attrs: parseMapValue(row[g.col] ?? row[g.col.split('[')[0]]),
    }))
    .filter((g) => Object.keys(g.attrs).length > 0);
}
