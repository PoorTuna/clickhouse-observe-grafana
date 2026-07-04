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
  limit = 500
): string {
  const tbl = `"${config.database}"."${config.logsTable}"`;
  const ts = config.columns.timestamp;
  return [
    `SELECT DISTINCT arrayJoin(mapKeys(${mapColumn})) AS k`,
    `FROM ${tbl}`,
    ts ? `WHERE ${ts} >= $__fromTime AND ${ts} <= $__toTime` : null,
    `LIMIT ${limit}`,
  ].filter(Boolean).join('\n');
}
