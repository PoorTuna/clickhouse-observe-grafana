import { SourceConfig } from '../types';

/** Fetch column names + types from system.columns for the logs table. */
export function buildColumnsQuery(config: SourceConfig): string {
  return (
    `SELECT name, type FROM system.columns` +
    ` WHERE database = '${config.database}' AND table = '${config.logsTable}'` +
    ` ORDER BY position`
  );
}

/** Discover distinct Map keys for a given Map column over the current time range. */
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
    `WHERE ${ts} >= $__fromTime AND ${ts} <= $__toTime`,
    `LIMIT ${limit}`,
  ].join('\n');
}
