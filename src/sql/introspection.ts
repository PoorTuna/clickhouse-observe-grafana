import { SourceConfig } from '../types';

/**
 * Execution guardrails for field-discovery scans (Map keys / JSON paths) — these queries scan
 * real data (bounded by time range, but the row cost to reach that many DISTINCT results isn't
 * bounded by LIMIT alone; see buildJsonPathsQuery's doc comment). Matches the values HyperDX
 * (github.com/hyperdxio/hyperdx, packages/common-utils/src/core/metadata.ts) uses for the same
 * class of query: stop after 15s or 3M rows read and return whatever was found so far instead of
 * hanging or erroring — 'break' overflow mode degrades to a partial result, which the caller
 * (FieldsContext.tsx) already tolerates (a column found 0/fewer keys this pass, not a crash).
 *
 * 'break' is safe here specifically because the output is a *set of field names*, not a count —
 * a truncated scan just finds fewer names, which reads to the user as "fewer autocomplete
 * suggestions this pass," not as a wrong number. Do not copy this pattern onto an aggregation
 * query (COUNT/GROUP BY): there, a rows-read cap doesn't bound truncated results to "fewer of the
 * right thing," it produces confidently-wrong numbers with no indication anything was cut short —
 * see VOLUME_QUERY_SETTINGS in queryBuilder.ts for the bug this caused and why it uses 'throw'.
 */
const DISCOVERY_SETTINGS =
  `SETTINGS max_execution_time = 15, timeout_overflow_mode = 'break', ` +
  `max_rows_to_read = 3000000, read_overflow_mode = 'break'`;

/** Matches HyperDX's DEFAULT_MAX_KEYS. */
const DEFAULT_DISCOVERY_LIMIT = 1000;

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
  limit = DEFAULT_DISCOVERY_LIMIT,
  table: string = config.logsTable
): string {
  const tbl = `"${config.database}"."${table}"`;
  const ts = config.columns.timestamp;
  return [
    `SELECT DISTINCT arrayJoin(mapKeys(${mapColumn})) AS k`,
    `FROM ${tbl}`,
    ts ? `WHERE ${ts} >= $__fromTime AND ${ts} <= $__toTime` : null,
    `LIMIT ${limit}`,
    DISCOVERY_SETTINGS,
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
  limit = DEFAULT_DISCOVERY_LIMIT,
  table: string = config.logsTable
): string {
  const tbl = `"${config.database}"."${table}"`;
  const ts = config.columns.timestamp;
  // JSONAllPathsWithTypes(...) returns Map(String, String) (path -> type). Evaluate it once per
  // row in the inner subquery (aliased `m`) instead of calling it twice at the outer level (once
  // for mapKeys, once for mapValues) — the previous version paid for the same dynamic-path
  // introspection twice per row, which is the expensive part of this query.
  return [
    `SELECT DISTINCT pt.1 AS path, pt.2 AS type`,
    `FROM (`,
    `  SELECT JSONAllPathsWithTypes(${jsonColumn}) AS m`,
    `  FROM ${tbl}`,
    ts ? `  WHERE ${ts} >= $__fromTime AND ${ts} <= $__toTime` : null,
    `)`,
    `ARRAY JOIN arrayZip(mapKeys(m), mapValues(m)) AS pt`,
    `LIMIT ${limit}`,
    DISCOVERY_SETTINGS,
  ].filter(Boolean).join('\n');
}
