import { SourceConfig } from '../types';
import { configSettingsFragments, withSettings } from './settings';

/**
 * Execution guardrail for field-discovery scans (Map keys / JSON paths) — these queries scan
 * real data (bounded by time range, but the row cost to reach every DISTINCT result isn't bounded
 * by anything else; see buildJsonPathsQuery's doc comment).
 *
 * Previously capped at 15s/3M rows read with `read_overflow_mode = 'break'`, matching HyperDX
 * (github.com/hyperdxio/hyperdx, packages/common-utils/src/core/metadata.ts) — the reasoning was
 * that a truncated scan just finds fewer field names, which reads as "fewer autocomplete
 * suggestions" rather than a wrong number. In practice that "fewer names" silently drops whole
 * Map/JSON columns from `fields`, which the log detail drawer depends on to flatten those columns
 * into dotted-path rows (LogDetailDrawer.tsx) — a capped scan there doesn't read as "fewer
 * suggestions," it reads as "the drawer is missing data." `throw` on timeout instead, same
 * reasoning as VOLUME_QUERY_SETTINGS in queryBuilder.ts: a loud failure the caller
 * (FieldsContext.tsx) already surfaces beats a quietly incomplete field list.
 */
const DISCOVERY_SETTINGS = [`max_execution_time = 60`, `timeout_overflow_mode = 'throw'`];

/** All databases available on this ClickHouse server. */
export function buildDatabasesQuery(): string {
  return `SELECT name FROM system.databases ORDER BY name`;
}

/** All tables (and views) in a given database. */
export function buildTablesQuery(database: string): string {
  return `SELECT name FROM system.tables WHERE database = '${database}' ORDER BY name`;
}

/** Fetch column names + types from system.columns for any database + table combination. */
export function buildColumnsQuery(config: SourceConfig, table: string): string {
  return withSettings(
    [
      `SELECT name, type FROM system.columns`,
      `WHERE database = '${config.database}' AND table = '${table}'`,
      `ORDER BY position`,
    ],
    configSettingsFragments(config)
  );
}

/**
 * Discover distinct Map keys for a given Map column, bounded to the current time range when a
 * timestamp column is mapped — a Map column can be mapped independently of a timestamp column,
 * so this must degrade to an unbounded scan rather than emit `undefined >= $__fromTime`.
 */
export function buildMapKeysQuery(
  config: SourceConfig,
  mapColumn: string,
  table: string = config.logsTable
): string {
  const tbl = `"${config.database}"."${table}"`;
  const ts = config.columns.timestamp;
  return withSettings(
    [
      `SELECT DISTINCT arrayJoin(mapKeys(${mapColumn})) AS k`,
      `FROM ${tbl}`,
      ts ? `WHERE ${ts} >= $__fromTime AND ${ts} <= $__toTime` : null,
    ],
    [...DISCOVERY_SETTINGS, ...configSettingsFragments(config)]
  );
}

/**
 * Discover distinct paths (+ their ClickHouse type) for a native JSON column, bounded to the
 * current time range when a timestamp column is mapped — mirrors buildMapKeysQuery's degradation
 * to an unbounded scan when no timestamp is available.
 *
 * JSONAllPathsWithTypes covers both type-hinted paths (declared in the column's JSON(...) type)
 * and dynamic paths (inferred per-row) — CH reports both through the same function, so no separate
 * query is needed to distinguish them. Returns one row per (path, type) pair; a path can appear
 * more than once if different rows observed different dynamic types for it — callers should
 * dedupe by path (first-seen wins).
 */
export function buildJsonPathsQuery(
  config: SourceConfig,
  jsonColumn: string,
  table: string = config.logsTable
): string {
  const tbl = `"${config.database}"."${table}"`;
  const ts = config.columns.timestamp;
  // JSONAllPathsWithTypes(...) returns Map(String, String) (path -> type). Evaluate it once per
  // row in the inner subquery (aliased `m`) instead of calling it twice at the outer level (once
  // for mapKeys, once for mapValues) — the previous version paid for the same dynamic-path
  // introspection twice per row, which is the expensive part of this query.
  return withSettings(
    [
      `SELECT DISTINCT pt.1 AS path, pt.2 AS type`,
      `FROM (`,
      `  SELECT JSONAllPathsWithTypes(${jsonColumn}) AS m`,
      `  FROM ${tbl}`,
      ts ? `  WHERE ${ts} >= $__fromTime AND ${ts} <= $__toTime` : null,
      `)`,
      `ARRAY JOIN arrayZip(mapKeys(m), mapValues(m)) AS pt`,
    ],
    [...DISCOVERY_SETTINGS, ...configSettingsFragments(config)]
  );
}
