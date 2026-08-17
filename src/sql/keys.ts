/**
 * Shared key-discovery helper for the sidebar's on-demand Map/JSON key browse (FieldKeysPopover).
 *
 * Wraps buildMapKeysQuery/buildJsonPathsQuery + runQueryRows with a module-level cache keyed by
 * datasourceUid:column:table:coarseTimeBucket:cacheKey — same scheme as kql/_values.ts's
 * valuesCache/buildValuesCacheKey, just for key lists instead of value lists. A separate cache
 * (not the same Map) since the two hold differently-shaped results, but the key-building logic is
 * intentionally the same pattern rather than an invented alternative.
 */

import { TimeRange } from '@grafana/data';
import { buildJsonPathsQuery, buildMapKeysQuery, KeyDiscoveryOpts } from './introspection';
import { runQueryRows } from '../data/runQuery';
import { coarseTimeBucket } from '../components/FieldsContext';
import { SourceConfig } from '../types';

export interface KeyEntry {
  key: string;
  /** ClickHouse-reported type for this path — JSON keys only; Map keys have no per-key type. */
  type?: string;
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

/** Runs the actual key-discovery query (no cache check) for a JSON column. */
export async function fetchJsonPaths(config: SourceConfig, jsonColumn: string, opts: LoadKeysOpts): Promise<KeysResult> {
  const sql = buildJsonPathsQuery(config, jsonColumn, opts);
  const rows = await runQueryRows({ datasourceUid: config.datasourceUid, sql, timeRange: opts.timeRange, op: 'jsonPaths' });
  // A path can appear more than once (different rows saw different dynamic types) — dedupe by
  // path, first-seen wins, per buildJsonPathsQuery's own doc comment.
  const seen = new Set<string>();
  const keys: KeyEntry[] = [];
  for (const r of rows) {
    const path = String(r['path'] ?? '');
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    keys.push({ key: path, type: String(r['type'] ?? '') });
  }
  const total = rows.length > 0 ? Number(rows[0]['total'] ?? 0) : 0;
  return { keys, total };
}

/**
 * Fetch (cached) the key list for a Map or JSON column, scoped to the current filter/time-range
 * context. Throws on failure — same "surface a real error" behavior as FieldStatsPopover's
 * fetchFieldValuesWithTotal, since this drives a popover with a visible error state, not
 * best-effort autocomplete.
 */
export async function loadColumnKeys(
  config: SourceConfig,
  column: string,
  columnType: 'map' | 'json',
  opts: LoadKeysOpts
): Promise<KeysResult> {
  const key = buildKeysCacheKey(config.datasourceUid, column, opts.timeRange, opts);
  const cached = keysCache.get(key);
  if (cached) {
    return cached;
  }
  const result = columnType === 'map' ? await fetchMapKeys(config, column, opts) : await fetchJsonPaths(config, column, opts);
  keysCache.set(key, result);
  return result;
}
