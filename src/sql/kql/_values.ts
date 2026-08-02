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

// Module-level cache. Invalidated naturally when the cache key changes.
const valuesCache = new Map<string, FieldValue[]>();

function cacheKey(uid: string, sqlExpr: string, timeRange: TimeRange, opts: LoadFieldValuesOpts): string {
  const bucket = coarseTimeBucket(timeRange);
  return `${uid}:${sqlExpr}:${opts.table}:${bucket}:${opts.cacheKey}`;
}

/**
 * Fetch the top distinct values for a field (by SQL expression).
 * Results are cached for the current time-bucket + filter context.
 */
export async function loadFieldValues(
  config: SourceConfig,
  sqlExpr: string,
  opts: LoadFieldValuesOpts
): Promise<FieldValue[]> {
  if (!config.datasourceUid) {
    return [];
  }

  const limit = opts.limit ?? 20;
  const key = cacheKey(config.datasourceUid, sqlExpr, opts.timeRange, opts);
  const cached = valuesCache.get(key);
  if (cached) {
    return cached;
  }

  try {
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
    valuesCache.set(key, values);
    return values;
  } catch {
    return [];
  }
}
