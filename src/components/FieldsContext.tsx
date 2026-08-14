import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { TimeRange } from '@grafana/data';
import { FieldModel, inferFieldType, parseTupleElements } from '../sql/fieldModel';
import type { FieldPresence } from './useFieldPresence';
import { buildColumnsQuery, buildMapKeysQuery, buildJsonPathsQuery } from '../sql/introspection';
import { quoteDottedPath, quoteString } from '../sql/queryBuilder';
import { runQueryRows } from '../data/runQuery';
import { SourceConfig } from '../types';
import { errMsg } from '../errMsg';

// Module-level caches survive re-renders; cleared on explicit refresh().
const columnCache = new Map<string, FieldModel[]>();
const mapKeyCache = new Map<string, string[]>();
const jsonPathCache = new Map<string, Array<{ path: string; chType: string }>>();

function columnCacheKey(config: SourceConfig, table: string): string {
  return `${config.datasourceUid}:${config.database}:${table}`;
}

function mapKeyCacheKey(config: SourceConfig, table: string, mapCol: string, bucket: string): string {
  return `${config.datasourceUid}:${config.database}:${table}:${mapCol}:${bucket}`;
}

function jsonPathCacheKey(config: SourceConfig, table: string, jsonCol: string, bucket: string): string {
  return `${config.datasourceUid}:${config.database}:${table}:${jsonCol}:${bucket}`;
}

/**
 * Discovery concurrency cap — Phase B (Map keys) and Phase C (JSON paths) used to fire one scan
 * query per column via a plain Promise.all, unbounded. Each query is now individually bounded
 * (see DISCOVERY_SETTINGS in introspection.ts, matching HyperDX's own execution guardrails), but
 * nothing capped how many ran *at once* — a table with 50 JSON columns fired 50 concurrent scans.
 * This staggers them instead: same total columns discovered, same accuracy, just a few at a time.
 */
const DISCOVERY_CONCURRENCY = 4;

/**
 * Runs `fn` over `items` with at most `limit` in flight at once. `fn` is expected to handle its
 * own errors (both call sites here already wrap their query in try/catch and resolve to a
 * fallback value) — a rejection from `fn` propagates out of this function same as Promise.all.
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
  /** Filter-aware Available/Empty split (see useFieldPresence.ts) — defaults to "unknown" (show
   *  everything) for providers that only call useFieldDiscovery and never compute presence
   *  (e.g. CreateDataViewModal's pinnable-fields lookup). */
  presence: FieldPresence;
}

const EMPTY_FIELDS_CONTEXT: FieldsContextValue = {
  fields: [],
  loading: false,
  error: null,
  refresh: () => {},
  presence: { present: null, status: 'unknown', loading: false },
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

/**
 * Discovers fields for a table in three phases: top-level columns, then (concurrently) Map keys
 * for any Map-typed columns and JSON paths for any JSON-typed columns found in phase A.
 */
export function useFieldDiscovery(
  config: SourceConfig,
  timeRange: TimeRange,
  opts: FieldDiscoveryOpts = {}
): FieldsContextValue {
  const { table } = opts;
  const resolvedTable = table ?? config.logsTable;
  const [fields, setFields] = useState<FieldModel[]>([]);
  // Starts true (not false): discovery always kicks off on mount once datasourceUid is known, so
  // an initial `false` is indistinguishable from "already checked, found nothing" to consumers
  // like BreakdownPicker's severity-fallback guard — that false-negative made it permanently
  // downgrade the severity breakdown to "none" on every fresh load, before fields even arrived.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
    }

    // Phase A: top-level columns (time-independent, cached per table)
    let columns: FieldModel[];
    if (columnCache.has(cKey)) {
      columns = columnCache.get(cKey)!;
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
        columnCache.set(cKey, columns);
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

    // Phase B: Map keys (time-bounded, cached per table + coarse bucket). Fired concurrently —
    // each column writes its own cache key, so there's no cross-column dependency. Auto-detect
    // every Map-typed column found in phase A — same treatment JSON columns already get; no
    // config field is required to enable discovery/autocomplete for a Map attribute column.
    const mapCols = columns.filter((f) => f.type === 'map').map((f) => f.name);

    const mapKeysPromise = runWithConcurrencyLimit(mapCols, DISCOVERY_CONCURRENCY, async (mapCol) => {
      const mKey = mapKeyCacheKey(config, resolvedTable, mapCol, bucket);
      const cached = mapKeyCache.get(mKey);
      if (cached) {
        return { mapCol, keys: cached, error: undefined as string | undefined };
      }
      try {
        const rows = await runQueryRows({
          datasourceUid: config.datasourceUid,
          sql: buildMapKeysQuery(config, mapCol, resolvedTable),
          timeRange,
          op: 'mapKeys',
        });
        const keys = rows.map((r) => String(r['k'] ?? '')).filter(Boolean);
        mapKeyCache.set(mKey, keys);
        return { mapCol, keys, error: undefined as string | undefined };
      } catch (e) {
        return { mapCol, keys: [] as string[], error: errMsg(e) };
      }
    });

    // Phase C: JSON paths (time-bounded, cached per table + coarse bucket) — one query per
    // JSON-typed column discovered in phase A, run concurrently alongside phase B's Map-key scans.
    const jsonCols = columns.filter((f) => f.type === 'json').map((f) => f.name);

    const jsonPathsPromise = runWithConcurrencyLimit(jsonCols, DISCOVERY_CONCURRENCY, async (jsonCol) => {
      const jKey = jsonPathCacheKey(config, resolvedTable, jsonCol, bucket);
      const cached = jsonPathCache.get(jKey);
      if (cached) {
        return { jsonCol, paths: cached, error: undefined as string | undefined };
      }
      try {
        const rows = await runQueryRows({
          datasourceUid: config.datasourceUid,
          sql: buildJsonPathsQuery(config, jsonCol, resolvedTable),
          timeRange,
          op: 'jsonPaths',
        });
        const paths = rows
          .map((r) => ({ path: String(r['path'] ?? ''), chType: String(r['type'] ?? '') }))
          .filter((p) => p.path);
        jsonPathCache.set(jKey, paths);
        return { jsonCol, paths, error: undefined as string | undefined };
      } catch (e) {
        return {
          jsonCol,
          paths: [] as Array<{ path: string; chType: string }>,
          error: errMsg(e),
        };
      }
    });

    const [perColKeys, perColPaths] = await Promise.all([mapKeysPromise, jsonPathsPromise]);

    // displayName is prefixed with the source column ("ResourceAttributes.k8s.namespace.name",
    // "Payload.user.id") so these read as what they are — a nested key discovered inside a real
    // mapped column — rather than looking like a standalone top-level column that was made up.
    // `name` stays the bare key: it's what KQL/filter-shorthand matching and SQL construction key
    // off of, and prefixing it would break both.
    const mapFields: FieldModel[] = [];
    for (const { mapCol, keys } of perColKeys) {
      for (const k of keys) {
        mapFields.push({
          id: `map:${mapCol}:${k}`,
          name: k,
          displayName: `${mapCol}.${k}`,
          // quoteString() properly escapes `k` (a real Map key read out of discovered *data*, not
          // something this codebase controls the shape of) — a key containing `'` used to produce
          // broken/injectable SQL (see C2 in the audit plan).
          sqlExpr: `${mapCol}[${quoteString(k)}]`,
          type: 'string',
          source: 'map',
          mapColumn: mapCol,
        });
      }
    }

    const jsonFields: FieldModel[] = [];
    for (const { jsonCol, paths } of perColPaths) {
      // A path can be reported more than once with different observed types across rows
      // (dynamic paths) — first-seen wins, matching the "cached, stable" contract of the rest
      // of field discovery rather than flip-flopping types query to query.
      const seen = new Set<string>();
      for (const { path, chType } of paths) {
        if (seen.has(path)) {
          continue;
        }
        seen.add(path);
        jsonFields.push({
          id: `json:${jsonCol}:${path}`,
          name: path,
          displayName: `${jsonCol}.${path}`,
          // quoteDottedPath() quotes any segment that isn't a bare-safe identifier — a real JSON
          // path like `user-id` or `k8s.io/name` isn't valid bare-identifier syntax and used to
          // produce a parse error or a silently different expression (`Payload.user-id` parses as
          // subtraction). See C2 in the audit plan.
          sqlExpr: quoteDottedPath(jsonCol, path),
          type: inferFieldType(chType),
          source: 'json',
          jsonColumn: jsonCol,
          jsonPath: path,
        });
      }
    }

    // Phase D: Tuple elements — unlike Map keys / JSON paths, no query is needed: a Tuple's
    // element list is fully determined by the type string Phase A already fetched
    // (system.columns), so this is a synchronous parse, not another concurrent scan.
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
          // Same reasoning as the JSON-path case above — a nested Tuple element name can also be
          // a non-bare-identifier string.
          sqlExpr: quoteDottedPath(col.name, el.name),
          type: inferFieldType(el.type),
          source: 'tuple',
          tupleColumn: col.name,
        });
      }
    }

    // Discovery failures (e.g. a Map/JSON scan timing out — see DISCOVERY_SETTINGS' 'throw')
    // must surface, not vanish into an empty key list that reads as "this column has no keys."
    // Still publish whatever fields *were* discovered — a visible error alongside partial fields,
    // never partial fields silently presented as complete.
    const failedCols = [
      ...perColKeys.filter((r) => r.error).map((r) => r.mapCol),
      ...perColPaths.filter((r) => r.error).map((r) => r.jsonCol),
    ];

    if (runRef.current === runId) {
      setFields([...columns, ...mapFields, ...jsonFields, ...tupleFields]);
      setLoading(false);
      setError(
        failedCols.length > 0
          ? `Field discovery failed for: ${failedCols.join(', ')}. Some Map/JSON attribute fields may be missing.`
          : null
      );
    }
  }

  const refresh = () => loadFields(true);

  // loadFields fetches columns/map-keys/json-paths async and mirrors the result into state — an
  // external fetch synced to React, not a render-time update.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadFields();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.datasourceUid, config.database, resolvedTable, bucket]);

  // This hook only discovers *schema*. Filter-aware presence is a separate concern computed by
  // useFieldPresence and merged in by callers that need it (see LogsExplorer.tsx) — callers that
  // only need discovery (e.g. CreateDataViewModal's pinnable-fields lookup) get the "unknown/show
  // everything" default here, same as EMPTY_FIELDS_CONTEXT.
  return { fields, loading, error, refresh, presence: EMPTY_FIELDS_CONTEXT.presence };
}
