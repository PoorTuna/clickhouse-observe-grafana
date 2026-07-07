import { SourceConfig } from '../types';

/** All databases available on this ClickHouse server. */
export function buildDatabasesQuery(): string {
  return `SELECT name FROM system.databases ORDER BY name`;
}

/** All tables (and views) in a given database. */
export function buildTablesQuery(database: string): string {
  return `SELECT name FROM system.tables WHERE database = '${database}' ORDER BY name`;
}

/** Fetch column names + types from system.columns for any database + table combination. */
export function buildColumnsQuery(database: string, table: string): string {
  return (
    `SELECT name, type FROM system.columns` +
    ` WHERE database = '${database}' AND table = '${table}'` +
    ` ORDER BY position`
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
  limit = 500,
  table: string = config.logsTable
): string {
  const tbl = `"${config.database}"."${table}"`;
  const ts = config.columns.timestamp;
  return [
    `SELECT DISTINCT arrayJoin(mapKeys(${mapColumn})) AS k`,
    `FROM ${tbl}`,
    ts ? `WHERE ${ts} >= $__fromTime AND ${ts} <= $__toTime` : null,
    `LIMIT ${limit}`,
  ].filter(Boolean).join('\n');
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
  limit = 500,
  table: string = config.logsTable
): string {
  const tbl = `"${config.database}"."${table}"`;
  const ts = config.columns.timestamp;
  // JSONAllPathsWithTypes(...) returns Map(String, String) (path -> type). Zip its keys/values
  // into Tuple(String, String) pairs first so ARRAY JOIN yields one (path, type) row per element —
  // ARRAY JOIN-ing a Map directly is ambiguous about key/value pairing across CH versions.
  return [
    `SELECT DISTINCT pt.1 AS path, pt.2 AS type`,
    `FROM ${tbl}`,
    `ARRAY JOIN arrayZip(mapKeys(JSONAllPathsWithTypes(${jsonColumn})), mapValues(JSONAllPathsWithTypes(${jsonColumn}))) AS pt`,
    ts ? `WHERE ${ts} >= $__fromTime AND ${ts} <= $__toTime` : null,
    `LIMIT ${limit}`,
  ].filter(Boolean).join('\n');
}
