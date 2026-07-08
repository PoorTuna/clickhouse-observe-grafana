import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { TimeRange } from '@grafana/data';
import { FieldModel, inferFieldType, selectMapColumns } from '../sql/fieldModel';
import { buildColumnsQuery, buildMapKeysQuery, buildJsonPathsQuery } from '../sql/introspection';
import { runQueryRows } from '../data/runQuery';
import { SourceConfig } from '../types';

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
// useFieldDiscovery() once and hand the value to <FieldsContext.Provider> directly, rather than
// nesting <FieldsProvider> (which would run discovery a second time, independently).
export const FieldsContext = createContext<FieldsContextValue>(EMPTY_FIELDS_CONTEXT);

export function useFields(): FieldsContextValue {
  return useContext(FieldsContext);
}

export interface FieldDiscoveryOpts {
  /** Table to introspect. Defaults to config.logsTable (existing Logs behavior). */
  table?: string;
  /** Map(String,String) columns to expand into individual key fields. Defaults to the logs Map columns. */
  mapColumns?: string[];
}

/**
 * Discovers fields for a table in three phases: top-level columns, then (concurrently) Map keys
 * for any Map-typed columns and JSON paths for any JSON-typed columns found in phase A.
 *
 * Extracted from FieldsProvider so pages that both provide field context to descendants AND need
 * the same field list for building queries (LogsExplorer, TraceExplorer) can call this once and
 * share the result both ways, instead of the page and <FieldsProvider> each discovering
 * independently.
 */
export function useFieldDiscovery(
  config: SourceConfig,
  timeRange: TimeRange,
  opts: FieldDiscoveryOpts = {}
): FieldsContextValue {
  const { table, mapColumns } = opts;
  const resolvedTable = table ?? config.logsTable;
  const resolvedMapColumns = useMemo(
    () =>
      mapColumns ?? [config.columns.resourceAttributes, config.columns.logAttributes, config.columns.scopeAttributes],

    [mapColumns, config.columns.resourceAttributes, config.columns.logAttributes, config.columns.scopeAttributes]
  );
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
          sql: buildColumnsQuery(config.database, resolvedTable),
          timeRange,
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
            };
          });
        columnCache.set(cKey, columns);
      } catch (e) {
        if (runRef.current === runId) {
          setError(String((e as Error)?.message ?? e));
          setLoading(false);
        }
        return;
      }
    }

    if (runRef.current !== runId) {
      return;
    }

    // Phase B: Map keys (time-bounded, cached per table + coarse bucket). Fired concurrently —
    // each column writes its own cache key, so there's no cross-column dependency. Narrowed to
    // columns actually typed Map in phase A — mapKeys() throws ILLEGAL_TYPE_OF_ARGUMENT (CH error
    // 43) against JSON/String columns, which some schemas use in place of the OTel-default Map.
    const mapCols = selectMapColumns(resolvedMapColumns, columns);

    const mapKeysPromise = Promise.all(
      mapCols.map(async (mapCol) => {
        const mKey = mapKeyCacheKey(config, resolvedTable, mapCol, bucket);
        const cached = mapKeyCache.get(mKey);
        if (cached) {
          return { mapCol, keys: cached };
        }
        try {
          const rows = await runQueryRows({
            datasourceUid: config.datasourceUid,
            sql: buildMapKeysQuery(config, mapCol, 500, resolvedTable),
            timeRange,
          });
          const keys = rows.map((r) => String(r['k'] ?? '')).filter(Boolean);
          mapKeyCache.set(mKey, keys);
          return { mapCol, keys };
        } catch {
          return { mapCol, keys: [] as string[] };
        }
      })
    );

    // Phase C: JSON paths (time-bounded, cached per table + coarse bucket) — one query per
    // JSON-typed column discovered in phase A, run concurrently alongside phase B's Map-key scans.
    const jsonCols = columns.filter((f) => f.type === 'json').map((f) => f.name);

    const jsonPathsPromise = Promise.all(
      jsonCols.map(async (jsonCol) => {
        const jKey = jsonPathCacheKey(config, resolvedTable, jsonCol, bucket);
        const cached = jsonPathCache.get(jKey);
        if (cached) {
          return { jsonCol, paths: cached };
        }
        try {
          const rows = await runQueryRows({
            datasourceUid: config.datasourceUid,
            sql: buildJsonPathsQuery(config, jsonCol, 500, resolvedTable),
            timeRange,
          });
          const paths = rows
            .map((r) => ({ path: String(r['path'] ?? ''), chType: String(r['type'] ?? '') }))
            .filter((p) => p.path);
          jsonPathCache.set(jKey, paths);
          return { jsonCol, paths };
        } catch {
          return { jsonCol, paths: [] as Array<{ path: string; chType: string }> };
        }
      })
    );

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
          sqlExpr: `${mapCol}['${k}']`,
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
          sqlExpr: `${jsonCol}.${path}`,
          type: inferFieldType(chType),
          source: 'json',
          jsonColumn: jsonCol,
          jsonPath: path,
        });
      }
    }

    if (runRef.current === runId) {
      setFields([...columns, ...mapFields, ...jsonFields]);
      setLoading(false);
      setError(null);
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

  return { fields, loading, error, refresh };
}

interface FieldsProviderProps extends FieldDiscoveryOpts {
  config: SourceConfig;
  timeRange: TimeRange;
  children: React.ReactNode;
}

/**
 * Convenience wrapper for consumers that only need field data via useFields() in descendants
 * (no local query-building use) — e.g. anywhere lighter-weight than LogsExplorer/TraceExplorer.
 * Those two pages use useFieldDiscovery() directly instead so they can also read the fields for
 * building their own queries; see that hook's doc comment.
 */
export function FieldsProvider({ config, timeRange, table, mapColumns, children }: FieldsProviderProps) {
  const value = useFieldDiscovery(config, timeRange, { table, mapColumns });
  return <FieldsContext.Provider value={value}>{children}</FieldsContext.Provider>;
}
