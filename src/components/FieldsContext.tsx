import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { TimeRange } from '@grafana/data';
import { FieldModel, inferFieldType, parseTupleElements } from '../sql/fieldModel';
import { buildColumnsQuery } from '../sql/introspection';
import { quoteDottedPath } from '../sql/queryBuilder';
import { detectPruneColumn, PruneCandidateColumn } from '../sql/pruneColumn';
import { runQueryRows } from '../data/runQuery';
import { SourceConfig } from '../types';
import { errMsg } from '../errMsg';

// Module-level cache survives re-renders; cleared on explicit refresh(). Keyed by table only —
// Map-key/JSON-path discovery (formerly Phase B/C, time-bucket-scoped) was deleted from this hot
// path; see the "Delete the presence query and its Available/Empty machinery" item in the perf
// plan. Attribute keys are now discovered on-demand instead, per Map/JSON column, when the user
// clicks that column in the sidebar (FieldKeysPopover, backed by sql/keys.ts) — not scanned here
// at mount, and not derived from hydrated rows either (that row-derived approach was itself later
// replaced by the on-demand popover; see the "on-demand nested-browse" plan).
const columnCache = new Map<string, FieldModel[]>();
// Raw system.columns rows backing columnCache's entry, kept alongside it (same key, same
// lifetime/invalidation) purely so detectPruneColumn can re-run against the widened columns
// (default_kind/default_expression/is_in_*_key/position — see introspection.ts's buildColumnsQuery)
// on a cache hit too, without a second round-trip.
const rawColumnCache = new Map<string, PruneCandidateColumn[]>();

function columnCacheKey(config: SourceConfig, table: string): string {
  return `${config.datasourceUid}:${config.database}:${table}`;
}

/**
 * Runs `fn` over `items` with at most `limit` in flight at once. Formerly used by this file's own
 * Phase B/C (Map-key/JSON-path) discovery, deleted from the mount-time hot path — see the perf
 * plan. Still a general-purpose utility, used by CreateDataViewModal's explicit "Guess with AI"
 * JSON-path scan (an on-demand user action, not mount-time discovery), so it stays exported here
 * rather than being deleted along with its original call site. `fn` is expected to handle its own
 * errors — a rejection from `fn` propagates out of this function same as Promise.all.
 */
export async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function coarseTimeBucket(timeRange: TimeRange): string {
  // Relative strings (e.g. 'now-1h') → stable key; absolute → round to 5 min.
  if (typeof timeRange.raw.from === 'string') {
    return `${timeRange.raw.from}|${timeRange.raw.to}`;
  }
  const snap = (ms: number) => Math.floor(ms / 300_000) * 300_000;
  return `${snap(timeRange.from.valueOf())}|${snap(timeRange.to.valueOf())}`;
}

interface FieldsContextValue {
  fields: FieldModel[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const EMPTY_FIELDS_CONTEXT: FieldsContextValue = {
  fields: [],
  loading: false,
  error: null,
  refresh: () => {},
};

// Exported (not just useFields()) so pages that need the same discovered fields for query
// building — not just for descendant consumers like FieldSidebar/SearchBar — can call
// useFieldDiscovery() once and hand the value to <FieldsContext.Provider> directly.
export const FieldsContext = createContext<FieldsContextValue>(EMPTY_FIELDS_CONTEXT);

export function useFields(): FieldsContextValue {
  return useContext(FieldsContext);
}

export interface FieldDiscoveryOpts {
  /** Table to introspect. Defaults to config.logsTable (existing Logs behavior). */
  table?: string;
}

export interface FieldDiscoveryResult extends FieldsContextValue {
  /**
   * Auto-detected coarse index-pruning column for `config.columns.timestamp` (see
   * sql/pruneColumn.ts), or `''` when none qualifies. App.tsx reads this to fill in
   * `columns.partitionTimestamp` at runtime when the persisted value is `''` (auto-detect) — see
   * SourceConfigContext's doc comment — so already-saved views benefit without re-saving.
   */
  detectedPartitionTimestamp: string;
}

/**
 * Discovers top-level columns for a table (system.columns, cached per table). Map-key/JSON-path
 * discovery used to run here too (former Phase B/C) — deleted from this hot path; see the perf
 * plan's "Delete the presence query and its Available/Empty machinery." `buildMapKeysQuery`/
 * `buildJsonPathsQuery` (introspection.ts) are no longer unused: FieldKeysPopover (FieldSidebar/)
 * calls them on-demand, scoped to the current search/filters/time range, when the user clicks a
 * Map/JSON column this function published — see the "on-demand nested-browse" plan.
 */
export function useFieldDiscovery(
  config: SourceConfig,
  timeRange: TimeRange,
  opts: FieldDiscoveryOpts = {}
): FieldDiscoveryResult {
  const { table } = opts;
  const resolvedTable = table ?? config.logsTable;
  const [fields, setFields] = useState<FieldModel[]>([]);
  // Starts true (not false): discovery always kicks off on mount once datasourceUid is known, so
  // an initial `false` is indistinguishable from "already checked, found nothing" to consumers
  // like BreakdownPicker's severity-fallback guard — that false-negative made it permanently
  // downgrade the severity breakdown to "none" on every fresh load, before fields even arrived.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detectedPartitionTimestamp, setDetectedPartitionTimestamp] = useState('');
  const runRef = useRef(0);

  const bucket = useMemo(() => coarseTimeBucket(timeRange), [timeRange]);

  async function loadFields(invalidateColumns = false) {
    if (!config.datasourceUid) {
      // No datasource configured yet — nothing to discover. Without this, `loading` (which
      // starts true) never resolves, so sidebar/pickers spin forever until a datasource shows up.
      setLoading(false);
      return;
    }
    const runId = ++runRef.current;
    const cKey = columnCacheKey(config, resolvedTable);

    if (invalidateColumns) {
      columnCache.delete(cKey);
      rawColumnCache.delete(cKey);
    }

    // Top-level columns (time-independent, cached per table).
    let columns: FieldModel[];
    let rawColumns: PruneCandidateColumn[];
    if (columnCache.has(cKey)) {
      columns = columnCache.get(cKey)!;
      rawColumns = rawColumnCache.get(cKey) ?? [];
    } else {
      setLoading(true);
      try {
        const rows = await runQueryRows({
          datasourceUid: config.datasourceUid,
          sql: buildColumnsQuery(config, resolvedTable),
          timeRange,
          op: 'columns',
        });
        columns = rows
          .filter((r) => String(r['name'] ?? '').length > 0)
          .map((r) => {
            const name = String(r['name']);
            const chType = String(r['type']);
            const type = inferFieldType(chType);
            return {
              id: `col:${name}`,
              name,
              displayName: name,
              sqlExpr: name,
              type,
              source: 'column' as const,
              rawType: chType,
            };
          });
        rawColumns = rows
          .filter((r) => String(r['name'] ?? '').length > 0)
          .map((r) => ({
            name: String(r['name']),
            type: String(r['type']),
            defaultKind: String(r['default_kind'] ?? ''),
            defaultExpression: String(r['default_expression'] ?? ''),
            isInPartitionKey: Number(r['is_in_partition_key'] ?? 0) === 1,
            isInPrimaryKey: Number(r['is_in_primary_key'] ?? 0) === 1,
            position: Number(r['position'] ?? 0),
          }));
        columnCache.set(cKey, columns);
        rawColumnCache.set(cKey, rawColumns);
      } catch (e) {
        if (runRef.current === runId) {
          setError(errMsg(e));
          setLoading(false);
        }
        return;
      }
    }

    if (runRef.current !== runId) {
      return;
    }

    // Tuple elements — unlike Map keys / JSON paths (deleted from this hot path), no query is
    // needed: a Tuple's element list is fully determined by the type string already fetched
    // (system.columns), so this is a synchronous parse, not a scan.
    // See parseTupleElements' doc comment (sql/fieldModel.ts) for the one-level-flatten boundary.
    const tupleFields: FieldModel[] = [];
    for (const col of columns) {
      if (col.type !== 'tuple' || !col.rawType) {
        continue;
      }
      for (const el of parseTupleElements(col.rawType)) {
        tupleFields.push({
          id: `tuple:${col.name}:${el.name}`,
          name: el.name,
          displayName: `${col.name}.${el.name}`,
          sqlExpr: quoteDottedPath(col.name, el.name),
          type: inferFieldType(el.type),
          source: 'tuple',
          tupleColumn: col.name,
        });
      }
    }

    const detected = detectPruneColumn(rawColumns, config.columns.timestamp) ?? '';

    if (runRef.current === runId) {
      setFields([...columns, ...tupleFields]);
      setLoading(false);
      setError(null);
      setDetectedPartitionTimestamp(detected);
    }
  }

  const refresh = () => loadFields(true);

  // loadFields fetches columns and mirrors the result into state — an external fetch synced to
  // React, not a render-time update.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadFields();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.datasourceUid, config.database, resolvedTable, bucket, config.columns.timestamp]);

  return { fields, loading, error, refresh, detectedPartitionTimestamp };
}
