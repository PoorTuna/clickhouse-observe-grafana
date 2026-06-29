/**
 * Shared value-lookup helper for KQL autocomplete.
 *
 * Wraps buildFieldTopValuesQuery + runQueryRows with a module-level cache keyed
 * by datasourceUid:sqlExpr:coarseTimeBucket:filtersHash — same scheme as
 * FieldStatsPopover so hot entries are often already warm.
 */

import { TimeRange } from '@grafana/data';
import { buildFieldTopValuesQuery } from '../queryBuilder';
import { runQueryRows } from '../../data/runQuery';
import { coarseTimeBucket } from '../../components/FieldsContext';
import { LogsQueryState, SourceConfig } from '../../types';

export interface FieldValue {
  value: string;
  count: number;
}

// Module-level cache. Invalidated naturally when the cache key changes.
const valuesCache = new Map<string, FieldValue[]>();

function cacheKey(
  uid: string,
  sqlExpr: string,
  timeRange: TimeRange,
  state: LogsQueryState
): string {
  const bucket = coarseTimeBucket(timeRange);
  const filtersHash = JSON.stringify([state.search, state.filters]);
  return `${uid}:${sqlExpr}:${bucket}:${filtersHash}`;
}

/**
 * Fetch the top distinct values for a field (by SQL expression).
 * Results are cached for the current time-bucket + filter context.
 */
export async function loadFieldValues(
  config: SourceConfig,
  state: LogsQueryState,
  timeRange: TimeRange,
  sqlExpr: string,
  limit = 20
): Promise<FieldValue[]> {
  if (!config.datasourceUid) {
    return [];
  }

  const key = cacheKey(config.datasourceUid, sqlExpr, timeRange, state);
  const cached = valuesCache.get(key);
  if (cached) {
    return cached;
  }

  try {
    const sql = buildFieldTopValuesQuery(config, state, sqlExpr, limit, 500);
    const rows = await runQueryRows({ datasourceUid: config.datasourceUid, sql, timeRange });
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
