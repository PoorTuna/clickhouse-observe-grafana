/**
 * Shared key-discovery helper for the sidebar's on-demand Map key browse (FieldKeysPopover).
 *
 * Wraps buildMapKeysQuery + runQueryRows with a module-level cache keyed by
 * datasourceUid:column:table:coarseTimeBucket:cacheKey — same scheme as kql/_values.ts's
 * valuesCache/buildValuesCacheKey, just for key lists instead of value lists. A separate cache
 * (not the same Map) since the two hold differently-shaped results, but the key-building logic is
 * intentionally the same pattern rather than an invented alternative.
 *
 * Map only. JSON paths are *not* discovered here anymore: ClickHouse can answer `distinctJSONPaths`
 * from part metadata as long as the query carries no filter, so those are discovered up front for
 * the whole table and published as first-class fields (FieldsContext Phase C). A Map column has no
 * such metadata — its keys live in row data — so it keeps this bounded, filter-scoped sample, paid
 * for only when the user actually opens the column.
 */

import { TimeRange } from '@grafana/data';
import { buildMapKeysQuery, KeyDiscoveryOpts } from './introspection';
import { runQueryRows } from '../data/runQuery';
import { coarseTimeBucket } from '../components/FieldsContext';
import { SourceConfig } from '../types';

export interface KeyEntry {
  key: string;
}

export interface KeysResult {
  keys: KeyEntry[];
  /** Sampled-row total the key list was discovered from (the sample CTE's row count) — same
   *  "real count, not hardcoded" pattern as FieldStatsPopover's "Calculated from N records". */
  total: number;
}

export interface LoadKeysOpts extends KeyDiscoveryOpts {
  timeRange: TimeRange;
  /** Caller-supplied hash of current filter state, so the cache key stays scoped per-page. */
  cacheKey: string;
}

// Module-level cache, same lifetime/scoping approach as kql/_values.ts's valuesCache.
export const keysCache = new Map<string, KeysResult>();

export function buildKeysCacheKey(uid: string, column: string, timeRange: TimeRange, opts: LoadKeysOpts): string {
  const bucket = coarseTimeBucket(timeRange);
  return `${uid}:${column}:${opts.table}:${bucket}:${opts.cacheKey}`;
}

/** Runs the actual key-discovery query (no cache check) for a Map column. */
export async function fetchMapKeys(config: SourceConfig, mapColumn: string, opts: LoadKeysOpts): Promise<KeysResult> {
  const sql = buildMapKeysQuery(config, mapColumn, opts);
  const rows = await runQueryRows({ datasourceUid: config.datasourceUid, sql, timeRange: opts.timeRange, op: 'mapKeys' });
  const keys: KeyEntry[] = rows.map((r) => ({ key: String(r['k'] ?? '') })).filter((k) => k.key.length > 0);
  const total = rows.length > 0 ? Number(rows[0]['total'] ?? 0) : 0;
  return { keys, total };
}

/**
 * Fetch (cached) the key list for a Map column, scoped to the current filter/time-range context.
 * Throws on failure — same "surface a real error" behavior as FieldStatsPopover's
 * fetchFieldValuesWithTotal, since this drives a popover with a visible error state, not
 * best-effort autocomplete.
 */
export async function loadColumnKeys(
  config: SourceConfig,
  column: string,
  opts: LoadKeysOpts
): Promise<KeysResult> {
  const key = buildKeysCacheKey(config.datasourceUid, column, opts.timeRange, opts);
  const cached = keysCache.get(key);
  if (cached) {
    return cached;
  }
  const result = await fetchMapKeys(config, column, opts);
  keysCache.set(key, result);
  return result;
}
