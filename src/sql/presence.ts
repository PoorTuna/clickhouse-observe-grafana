/**
 * "Which discovered fields actually have values under the current search/filters/time range?" —
 * powers the sidebar's Available/Empty split (see FieldSidebar.tsx). Schema-level discovery
 * (FieldsContext.tsx) says a field *exists*; this says whether it's *populated* in what's on
 * screen right now, which is a property of the filtered result set, not the schema.
 *
 * Modeled on Kibana's own field-existence check (kbn-unified-field-list's use_existing_fields):
 * it samples documents rather than scanning the whole index, and re-derives on every
 * query/filter/time-range change. This does the same over a bounded sample of the newest matching
 * rows, using one aggregate query so the cost stays flat regardless of field count.
 */

import { FieldModel } from './fieldModel';
import { FieldIndex } from './fields';
import { LogsQueryState, SourceConfig } from '../types';
import { buildWhereConditions } from './queryBuilder';
import { configSettingsFragments, withSettings } from './settings';

/** Newest-N-matching-rows sample, same trade-off as Kibana's doc sample — a field that only shows
 *  up outside this window can be misclassified as Empty. */
export const PRESENCE_SAMPLE_ROWS = 500;

/** Caps how many presence expressions one query emits — a pathologically wide table (hundreds of
 *  columns/keys) must not produce a thousand-expression SELECT. Fields past the cap are omitted
 *  from the query and treated as present (degrade toward showing more, never toward hiding a
 *  field the user might actually have). */
export const MAX_PRESENCE_AGGREGATES = 300;

export interface FieldPresenceQuery {
  sql: string;
  /** Field id -> result column alias, for scalar column/tuple presence counts (countIf). */
  columnAliases: Map<string, string>;
  /** Map column name -> result column alias holding groupUniqArrayArray(mapKeys(...)). */
  mapKeyAliases: Map<string, string>;
  /** JSON column name -> result column alias holding groupUniqArrayArray(JSONAllPaths(...)). */
  jsonPathAliases: Map<string, string>;
}

function scalarPresenceExpr(field: FieldModel): string {
  if (field.type === 'string') {
    return `countIf(${field.sqlExpr} IS NOT NULL AND ${field.sqlExpr} != '')`;
  }
  return `countIf(${field.sqlExpr} IS NOT NULL)`;
}

/**
 * Builds the presence-sampling query, or returns null when there's nothing to ask about (no
 * fields yet, or no datasource-backed table to query).
 */
export function buildFieldPresenceQuery(
  config: SourceConfig,
  state: LogsQueryState,
  fields: FieldModel[],
  index?: FieldIndex
): FieldPresenceQuery | null {
  if (fields.length === 0) {
    return null;
  }

  const tbl = `"${config.database}"."${config.logsTable}"`;
  const ts = config.columns.timestamp;

  const selectExprs: string[] = [];
  const innerCols = new Set<string>();
  const columnAliases = new Map<string, string>();
  const mapKeyAliases = new Map<string, string>();
  const jsonPathAliases = new Map<string, string>();
  const seenMapCols = new Set<string>();
  const seenJsonCols = new Set<string>();

  let aggIdx = 0;
  const nextAlias = () => `p${aggIdx++}`;

  for (const field of fields) {
    if (aggIdx >= MAX_PRESENCE_AGGREGATES) {
      break;
    }
    if (field.source === 'column' || field.source === 'tuple') {
      const alias = nextAlias();
      selectExprs.push(`${scalarPresenceExpr(field)} AS ${alias}`);
      columnAliases.set(field.id, alias);
      // Tuple elements read off the tuple's own parent column, not a standalone select.
      innerCols.add(field.source === 'tuple' ? field.tupleColumn! : field.sqlExpr);
    } else if (field.source === 'map' && field.mapColumn) {
      if (!seenMapCols.has(field.mapColumn)) {
        seenMapCols.add(field.mapColumn);
        const alias = nextAlias();
        selectExprs.push(`groupUniqArrayArray(mapKeys(${field.mapColumn})) AS ${alias}`);
        mapKeyAliases.set(field.mapColumn, alias);
        innerCols.add(field.mapColumn);
      }
    } else if (field.source === 'json' && field.jsonColumn) {
      if (!seenJsonCols.has(field.jsonColumn)) {
        seenJsonCols.add(field.jsonColumn);
        const alias = nextAlias();
        selectExprs.push(`groupUniqArrayArray(JSONAllPaths(${field.jsonColumn})) AS ${alias}`);
        jsonPathAliases.set(field.jsonColumn, alias);
        innerCols.add(field.jsonColumn);
      }
    }
  }

  if (selectExprs.length === 0) {
    return null;
  }

  const conditions = buildWhereConditions(config, state, index);

  const sql = withSettings(
    [
      `SELECT ${selectExprs.join(', ')}`,
      `FROM (`,
      `  SELECT ${[...innerCols].join(', ')}`,
      `  FROM ${tbl}`,
      conditions.length > 0 ? `  WHERE ${conditions.join(' AND ')}` : null,
      ts ? `  ORDER BY ${ts} DESC` : null,
      `  LIMIT ${PRESENCE_SAMPLE_ROWS}`,
      `)`,
    ],
    [`max_execution_time = 15`, `timeout_overflow_mode = 'throw'`, ...configSettingsFragments(config)]
  );

  return { sql, columnAliases, mapKeyAliases, jsonPathAliases };
}
