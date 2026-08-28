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

/** Options for buildJsonPathsQuery — deliberately narrower than KeyDiscoveryOpts: this query takes
 *  no filter conditions and no sample size, because either one would defeat the optimization it
 *  depends on (see below). */
export interface JsonPathDiscoveryOpts {
  /** Table to read from (e.g. config.logsTable). */
  table: string;
}

/**
 * Discover every distinct path in a native JSON column, across the whole table.
 *
 * Unlike `buildMapKeysQuery` this is *not* a bounded sample, and it is deliberately unfiltered:
 * ClickHouse (25.12+, PR #92196) rewrites `distinctJSONPaths(col)` in `FunctionToSubcolumnsPass`
 * into a read of a special paths-only subcolumn — the object-structure substream plus the
 * shared-data paths, never the values — which answers "what paths exist" for roughly the cost of
 * reading part metadata. That rewrite fires only when:
 *
 *   - `optimize_functions_to_subcolumns = 1` (sent below, in case a profile turned it off), and
 *   - the query has **no WHERE, PREWHERE or GROUP BY** — `canOptimizeWithWherePrewhereOrGroupBy`
 *     singles this function out, because a filtered path list can't be answered from metadata.
 *
 * So a time/filter predicate here doesn't make the query cheaper, it makes it ~5x more expensive:
 * it forfeits the metadata path and falls back to reading the whole JSON column for every matching
 * row (measured on a user's table: ~3-5s bare vs 20s+ with a time filter). Hence: no conditions, no
 * ORDER BY, no LIMIT — and the tests in `json_fields.test.ts` assert their absence on purpose.
 *
 * `enable_analyzer` is intentionally *not* sent: that pass is analyzer-only, but the setting was
 * renamed from `allow_experimental_analyzer` in the 24.x line, and an unknown setting name fails
 * the whole query on an older server. The analyzer is on by default anyway (24.3+).
 *
 * Nothing else may be selected alongside the paths — in particular no `count()`. Once the rewrite
 * fires, the special subcolumn materializes one row per read block, so a row-counting aggregate in
 * the same query returns the block count, not the row count. Measured on CH 26.3.17.4 against a
 * 50 000-row table: `SELECT count(), distinctJSONPaths(p) FROM t` returns 24 with
 * `optimize_functions_to_subcolumns = 1` and 50 000 with it off. That's why this query has no
 * "discovered from N records" companion the way buildMapKeysQuery does.
 *
 * The result is wrapped in `toJSONString(...)` so it comes back as one scalar String cell rather
 * than an `Array(String)` whose DataFrame marshalling would be datasource-specific; callers
 * `JSON.parse` it. Paths come back sorted, and carry no type information — `distinctJSONPathsAndTypes`
 * is *not* covered by the same optimization, so types for declared paths come from parsing the
 * column's own `JSON(...)` type instead (see `parseJsonTypedPaths` in sql/fieldModel.ts).
 */
export function buildJsonPathsQuery(
  config: SourceConfig,
  jsonColumn: string,
  opts: JsonPathDiscoveryOpts
): string {
  const tbl = `"${config.database}"."${opts.table}"`;
  return withSettings(
    [
      `SELECT toJSONString(distinctJSONPaths(${jsonColumn})) AS paths`,
      `FROM ${tbl}`,
    ],
    ['optimize_functions_to_subcolumns = 1', ...discoverySettings(config), ...configSettingsFragments(config)]
  );
}
