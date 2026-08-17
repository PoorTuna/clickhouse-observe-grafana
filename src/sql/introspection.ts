import { SourceConfig } from '../types';
import { configSettingsFragments, queryTimeoutFragments, withSettings } from './settings';

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
 *
 * The number itself now comes from queryTimeoutFragments(config) — see settings.ts's doc comment
 * for why every query builder in this codebase shares one config-driven budget instead of each
 * picking its own (this used to be a hardcoded 60s, well above a typical reverse-proxy's own
 * timeout).
 */
function discoverySettings(config: SourceConfig): string[] {
  return queryTimeoutFragments(config);
}

/** All databases available on this ClickHouse server. */
export function buildDatabasesQuery(): string {
  return `SELECT name FROM system.databases ORDER BY name`;
}

/** All tables (and views) in a given database. */
export function buildTablesQuery(database: string): string {
  return `SELECT name FROM system.tables WHERE database = '${database}' ORDER BY name`;
}

/**
 * Fetch column names + types from system.columns for any database + table combination. Also
 * fetches default_kind/default_expression/is_in_partition_key/is_in_primary_key/position — enough
 * for sql/pruneColumn.ts to detect a safe coarse index-pruning column (see its doc comment) without
 * a second round-trip. This query already runs once per mount and is cached (FieldsContext.tsx's
 * columnCache), so widening its SELECT list is free.
 */
export function buildColumnsQuery(config: SourceConfig, table: string): string {
  return withSettings(
    [
      `SELECT name, type, default_kind, default_expression, is_in_partition_key, is_in_primary_key, position`,
      `FROM system.columns`,
      `WHERE database = '${config.database}' AND table = '${table}'`,
      `ORDER BY position`,
    ],
    configSettingsFragments(config)
  );
}

export interface KeyDiscoveryOpts {
  /** Table to sample from (e.g. config.logsTable). */
  table: string;
  /** Pre-built WHERE conditions (from buildWhereConditions) — current time range + active
   *  search/filters, not just a bare timestamp bound. */
  conditions: string[];
  sampleSize?: number;
}

/**
 * Discover distinct Map keys for a given Map column, scoped to the current filter/time-range
 * context (`opts.conditions`, built via `buildWhereConditions` — same as `buildFieldTopValuesQuery`
 * for "top values"). Samples the most-recent `sampleSize` rows (ordered by the mapped timestamp
 * column, when one exists, so the sample is read via the primary-key index) and discovers keys
 * only within that sample — same bounded-cost shape as `buildFieldTopValuesQuery`, in place of the
 * old unbounded `SELECT DISTINCT arrayJoin(mapKeys(...))` full scan. `discoverySettings` stays on
 * as a guardrail for the pathological sparse-match case (a narrow filter over a wide range can
 * still take a while to fill the sample), even though the LIMIT-bounded subquery is now the main
 * cost control.
 */
export function buildMapKeysQuery(
  config: SourceConfig,
  mapColumn: string,
  opts: KeyDiscoveryOpts
): string {
  const { table, conditions, sampleSize = 500 } = opts;
  const tbl = `"${config.database}"."${table}"`;
  const tsCol = config.columns.timestamp;
  const condClause = conditions.length > 0 ? `  WHERE ${conditions.join(' AND ')}` : null;
  return withSettings(
    [
      `WITH sample AS (`,
      `  SELECT ${mapColumn} AS m`,
      `  FROM ${tbl}`,
      condClause,
      tsCol ? `  ORDER BY ${tsCol} DESC` : null,
      `  LIMIT ${sampleSize}`,
      `)`,
      `SELECT DISTINCT arrayJoin(mapKeys(m)) AS k, (SELECT count() FROM sample) AS total`,
      `FROM sample`,
    ],
    [...discoverySettings(config), ...configSettingsFragments(config)]
  );
}

/**
 * Discover distinct paths (+ their ClickHouse type) for a native JSON column, scoped to the same
 * bounded sample-CTE shape as `buildMapKeysQuery` — see its doc comment for why.
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
  opts: KeyDiscoveryOpts
): string {
  const { table, conditions, sampleSize = 500 } = opts;
  const tbl = `"${config.database}"."${table}"`;
  const tsCol = config.columns.timestamp;
  const condClause = conditions.length > 0 ? `  WHERE ${conditions.join(' AND ')}` : null;
  // JSONAllPathsWithTypes(...) returns Map(String, String) (path -> type). Evaluate it once per
  // sampled row (aliased `m`) instead of calling it twice at the outer level (once for mapKeys,
  // once for mapValues) — paying for the same dynamic-path introspection twice per row is the
  // expensive part of this query.
  return withSettings(
    [
      `WITH sample AS (`,
      `  SELECT ${jsonColumn} AS j`,
      `  FROM ${tbl}`,
      condClause,
      tsCol ? `  ORDER BY ${tsCol} DESC` : null,
      `  LIMIT ${sampleSize}`,
      `)`,
      `SELECT DISTINCT pt.1 AS path, pt.2 AS type, (SELECT count() FROM sample) AS total`,
      `FROM (`,
      `  SELECT JSONAllPathsWithTypes(j) AS m`,
      `  FROM sample`,
      `)`,
      `ARRAY JOIN arrayZip(mapKeys(m), mapValues(m)) AS pt`,
    ],
    [...discoverySettings(config), ...configSettingsFragments(config)]
  );
}
