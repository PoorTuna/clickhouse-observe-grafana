/**
 * Shared key-discovery helper for on-demand Map key browse — used by both the sidebar's
 * FieldKeysPopover and the search bar's dot-drilldown autocomplete (SearchBar.tsx).
 *
 * Wraps buildMapKeysQuery + runQueryRows with a module-level cache keyed by
 * datasourceUid:column:table:coarseTimeBucket:cacheKey — same scheme as
 * kql/_values.ts's valuesCache, just for key lists instead of value lists. A separate cache
 * (not the same Map) since the two hold differently-shaped results, but the key-building logic is
 * intentionally the same pattern rather than an invented alternative.
 *
 * Map only. JSON paths are *not* discovered here anymore: ClickHouse can answer `distinctJSONPaths`
 * from part metadata as long as the query carries no filter, so those are discovered up front for
 * the whole table and published as first-class fields (FieldsContext Phase C). A Map column has no
 * such metadata — its keys live in row data — so it keeps this bounded, filter-scoped sample, paid
 * for only when the user actually opens the column (from either surface).
 *
 * Fetched keys are deliberately NOT published into FieldsContext's `fields`: they're sample-scoped
 * (a LIMIT-bounded read under the *current* filters/time range), so treating them as schema would
 * make transient, filter-dependent data look permanent — the opposite of what makes JSON paths safe
 * to publish. They live only in this module's cache, which both UI surfaces read through.
 */

import { TimeRange } from '@grafana/data';
import { buildMapKeysQuery, KeyDiscoveryOpts } from './introspection';
import { runQueryRows } from '../data/runQuery';
import { coarseTimeBucket } from './timeBucket';
import { quoteString } from './queryBuilder';
import { FieldModel } from './fieldModel';
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

interface CachedKeysResult extends KeysResult {
  fetchedAt: number;
}

export interface LoadKeysOpts extends KeyDiscoveryOpts {
  timeRange: TimeRange;
  /** Caller-supplied hash of current filter state, so the cache key stays scoped per-page. */
  cacheKey: string;
}

// Module-level cache, same lifetime/scoping approach as kql/_values.ts's valuesCache — plus a TTL
// (below), since a Map key list is sample-scoped and `coarseTimeBucket` is a stable string for
// relative time ranges (`now-1h|now` never rolls over on its own), so without a TTL a key added
// after the sample was taken would stay invisible for the rest of the session.
export const keysCache = new Map<string, CachedKeysResult>();

/** How long a cached key list is trusted before a fresh fetch is required, independent of
 *  `coarseTimeBucket` rolling over. Roughly one auto-refresh cycle — long enough that browsing the
 *  same column twice in a row (sidebar then search bar, or vice versa) stays a cache hit, short
 *  enough that a relative time range ("now-15m") doesn't serve a frozen key list all session. */
export const KEYS_TTL_MS = 120_000;

// In-flight de-duplication: the sidebar popover and the search bar can both ask for the same
// column's keys within the same render tick (e.g. the user opens the sidebar entry right after
// accepting a dot-drilldown suggestion for the same column) — without this they'd fire two
// identical queries instead of sharing one.
const inFlight = new Map<string, Promise<KeysResult>>();

export function buildKeysCacheKey(uid: string, column: string, timeRange: TimeRange, opts: LoadKeysOpts): string {
  const bucket = coarseTimeBucket(timeRange);
  return `${uid}:${column}:${opts.table}:${bucket}:${opts.cacheKey}`;
}

function isFresh(entry: CachedKeysResult): boolean {
  return Date.now() - entry.fetchedAt < KEYS_TTL_MS;
}

/** Synchronous cache peek — lets a caller (FieldKeysPopover, SearchBar) render a fresh cached
 *  result immediately instead of flashing a loading state for one microtask while
 *  loadColumnKeys's own (necessarily async) cache check resolves. Returns undefined on a miss or
 *  stale entry, exactly like a normal Map.get would on a miss. */
export function peekColumnKeys(uid: string, column: string, timeRange: TimeRange, opts: LoadKeysOpts): KeysResult | undefined {
  const key = buildKeysCacheKey(uid, column, timeRange, opts);
  const cached = keysCache.get(key);
  return cached && isFresh(cached) ? cached : undefined;
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
 * Fetch (cached, TTL'd, de-duplicated) the key list for a Map column, scoped to the current
 * filter/time-range context. Throws on failure — same "surface a real error" behavior as
 * FieldStatsPopover's fetchFieldValuesWithTotal, since both the sidebar popover and the search bar
 * drive a visible error state from this, not best-effort autocomplete.
 */
export async function loadColumnKeys(
  config: SourceConfig,
  column: string,
  opts: LoadKeysOpts
): Promise<KeysResult> {
  const key = buildKeysCacheKey(config.datasourceUid, column, opts.timeRange, opts);
  const cached = keysCache.get(key);
  if (cached && isFresh(cached)) {
    return cached;
  }

  const existing = inFlight.get(key);
  if (existing) {
    return existing;
  }

  const promise = fetchMapKeys(config, column, opts)
    .then((result) => {
      keysCache.set(key, { ...result, fetchedAt: Date.now() });
      return result;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

/** Test-only: clears both the cache and the in-flight tracker. Production code never needs a
 *  blanket reset (real requests always eventually settle, via success/error/abort), but a test
 *  double that deliberately never resolves (a loading-state assertion) would otherwise leave a
 *  permanently-stuck in-flight entry that a later test's identical cache key would reuse. */
export function __resetKeysCacheForTests(): void {
  keysCache.clear();
  inFlight.clear();
}

/** Drops every cached (and in-flight-tracked) key list for one datasource+table — used by
 *  FieldsContext's explicit refresh() so a user-triggered "reload fields" doesn't keep serving a
 *  stale sample. Cache keys are `uid:column:table:bucket:cacheKey`, so table isn't a prefix —
 *  match it as a `:table:` segment instead. */
export function clearKeysCacheForTable(uid: string, table: string): void {
  const prefix = `${uid}:`;
  const marker = `:${table}:`;
  for (const key of [...keysCache.keys()]) {
    if (key.startsWith(prefix) && key.includes(marker)) {
      keysCache.delete(key);
    }
  }
}

/**
 * Builds the leaf FieldModel for a discovered Map key. Single source of truth for the id/sqlExpr
 * scheme (`map:${col}:${key}` / `${col}[${quoteString(key)}]`) — used by the sidebar's
 * FieldKeysPopover, the search bar's map-key suggestions (sql/kql/suggest.ts), and resolveField's
 * dotted-map-key fallback (sql/fields.ts), so all three converge on the same field identity for the
 * same key instead of each inventing their own.
 */
export function buildMapKeyField(mapColumnName: string, entry: KeyEntry): FieldModel {
  return {
    id: `map:${mapColumnName}:${entry.key}`,
    name: entry.key,
    displayName: `${mapColumnName}.${entry.key}`,
    sqlExpr: `${mapColumnName}[${quoteString(entry.key)}]`,
    type: 'string',
    source: 'map',
    mapColumn: mapColumnName,
  };
}
