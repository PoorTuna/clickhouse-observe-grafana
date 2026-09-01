/**
 * Shared value-lookup helper for KQL autocomplete.
 *
 * Wraps buildFieldTopValuesQuery + runQueryRows with a module-level cache keyed
 * by datasourceUid:sqlExpr:coarseTimeBucket:cacheKey — same scheme as
 * FieldStatsPopover so hot entries are often already warm.
 *
 * Table-agnostic: callers supply their own table + pre-built WHERE conditions + a
 * cacheKey representing their current filter state, so this module has no knowledge
 * of LogsQueryState.
 */

import { TimeRange } from '@grafana/data';
import { buildFieldTopValuesQuery } from '../queryBuilder';
import { runQueryRows } from '../../data/runQuery';
import { coarseTimeBucket } from '../timeBucket';
import { SourceConfig } from '../../types';

export interface FieldValue {
  value: string;
  count: number;
}

/** Values + the sampled row total the counts/percentages are drawn from — the shape
 *  FieldStatsPopover needs for its "Calculated from N records" caption and per-value percentages.
 *  loadFieldValues() (below) is the same fetch, just discarding `total` for callers that only need
 *  the plain value list (SearchBar/FilterEditForm autocomplete). */
export interface FieldValuesWithTotal {
  values: FieldValue[];
  total: number;
}

export interface LoadFieldValuesOpts {
  /** Table to sample from (e.g. config.logsTable). */
  table: string;
  /** Pre-built WHERE conditions (from buildWhereConditions). */
  conditions: string[];
  timeRange: TimeRange;
  /** Caller-supplied hash of current filter state, so the cache key stays scoped per-page. */
  cacheKey: string;
  limit?: number;
}

// Module-level cache, keyed and shared the same way regardless of caller — FieldStatsPopover and
// the KQL autocomplete path used to keep two separate caches for the identical query shape (top
// distinct values for a field, sampled + bounded the same way by buildFieldTopValuesQuery), which
// meant they could each hold a different answer for the same field+filter context. Exported (not
// just wrapped) so a caller that needs different error handling than loadFieldValuesWithTotal's
// swallow-and-return-empty (see FieldStatsPopover, which surfaces a real error banner instead of
// reading a query failure as "no values") can still read/write the same cache entries directly.
interface CachedFieldValues extends FieldValuesWithTotal {
  fetchedAt: number;
}

export const valuesCache = new Map<string, CachedFieldValues>();

/** Same TTL rationale as sql/keys.ts's KEYS_TTL_MS: a value list is sampled from current row data,
 *  and `coarseTimeBucket` is a stable string for relative time ranges, so without a TTL a value
 *  that starts appearing after the sample was taken stays invisible for the rest of the session. */
export const VALUES_TTL_MS = 120_000;

const inFlight = new Map<string, Promise<FieldValuesWithTotal>>();

/** Exported so a caller doing its own cache read (FieldStatsPopover, which needs the throwing
 *  fetch + a real error banner instead of loadFieldValuesWithTotal's swallow-to-empty) can apply
 *  the same TTL check instead of re-deriving it. */
export function isValuesCacheEntryFresh(entry: CachedFieldValues): boolean {
  return Date.now() - entry.fetchedAt < VALUES_TTL_MS;
}

export function buildValuesCacheKey(uid: string, sqlExpr: string, timeRange: TimeRange, opts: LoadFieldValuesOpts): string {
  const bucket = coarseTimeBucket(timeRange);
  return `${uid}:${sqlExpr}:${opts.table}:${bucket}:${opts.cacheKey}`;
}

/** Drops every cached value list for one datasource+table — used by FieldsContext's explicit
 *  refresh(). Cache keys are `uid:sqlExpr:table:bucket:cacheKey`, so table isn't a prefix — match
 *  it as a `:table:` segment instead, same approach as sql/keys.ts's clearKeysCacheForTable. */
export function clearValuesCacheForTable(uid: string, table: string): void {
  const prefix = `${uid}:`;
  const marker = `:${table}:`;
  for (const key of [...valuesCache.keys()]) {
    if (key.startsWith(prefix) && key.includes(marker)) {
      valuesCache.delete(key);
    }
  }
}

/**
 * Runs the actual top-values query (no cache check, no error handling) — the one query-building +
 * row-parsing implementation both loadFieldValuesWithTotal below and FieldStatsPopover's own
 * fetch (which needs to catch the error itself, see its doc comment) call into.
 */
export async function fetchFieldValuesWithTotal(
  config: SourceConfig,
  sqlExpr: string,
  opts: LoadFieldValuesOpts
): Promise<FieldValuesWithTotal> {
  const limit = opts.limit ?? 20;
  const sql = buildFieldTopValuesQuery(config, sqlExpr, {
    table: opts.table,
    conditions: opts.conditions,
    limit,
    sampleSize: 500,
  });
  const rows = await runQueryRows({ datasourceUid: config.datasourceUid, sql, timeRange: opts.timeRange, op: 'fieldValues' });
  const values: FieldValue[] = rows.map((r) => ({
    value: String(r['value'] ?? ''),
    count: Number(r['count'] ?? 0),
  }));
  // total is the same for every row — from buildFieldTopValuesQuery's CTE scalar subquery.
  const total = rows.length > 0 ? Number(rows[0]['total'] ?? 0) : 0;
  return { values, total };
}

/**
 * Fetch the top distinct values for a field (by SQL expression), plus the sampled row total the
 * counts were computed from. Results are cached for the current time-bucket + filter context.
 * Best-effort: any query failure resolves to an empty result rather than throwing — the right
 * behavior for autocomplete (no suggestions beats a broken dropdown), but not for a caller that
 * wants to show the user why a fetch failed (see fetchFieldValuesWithTotal for that case).
 */
export async function loadFieldValuesWithTotal(
  config: SourceConfig,
  sqlExpr: string,
  opts: LoadFieldValuesOpts
): Promise<FieldValuesWithTotal> {
  if (!config.datasourceUid) {
    return { values: [], total: 0 };
  }

  const key = buildValuesCacheKey(config.datasourceUid, sqlExpr, opts.timeRange, opts);
  const cached = valuesCache.get(key);
  if (cached && isValuesCacheEntryFresh(cached)) {
    return cached;
  }

  const existing = inFlight.get(key);
  if (existing) {
    return existing;
  }

  const promise = fetchFieldValuesWithTotal(config, sqlExpr, opts)
    .then((result) => {
      valuesCache.set(key, { ...result, fetchedAt: Date.now() });
      return result;
    })
    .catch(() => ({ values: [], total: 0 }))
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

/**
 * Fetch just the top distinct values for a field — the plain-list shape KQL/filter-form
 * autocomplete needs. Thin wrapper over loadFieldValuesWithTotal so both entry points share one
 * fetch + one cache.
 */
export async function loadFieldValues(
  config: SourceConfig,
  sqlExpr: string,
  opts: LoadFieldValuesOpts
): Promise<FieldValue[]> {
  return (await loadFieldValuesWithTotal(config, sqlExpr, opts)).values;
}
