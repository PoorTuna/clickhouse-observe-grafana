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
import { coarseTimeBucket } from '../../components/FieldsContext';
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
export const valuesCache = new Map<string, FieldValuesWithTotal>();

export function buildValuesCacheKey(uid: string, sqlExpr: string, timeRange: TimeRange, opts: LoadFieldValuesOpts): string {
  const bucket = coarseTimeBucket(timeRange);
  return `${uid}:${sqlExpr}:${opts.table}:${bucket}:${opts.cacheKey}`;
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
  const rows = await runQueryRows({ datasourceUid: config.datasourceUid, sql, timeRange: opts.timeRange });
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
  if (cached) {
    return cached;
  }

  try {
    const result = await fetchFieldValuesWithTotal(config, sqlExpr, opts);
    valuesCache.set(key, result);
    return result;
  } catch {
    return { values: [], total: 0 };
  }
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
