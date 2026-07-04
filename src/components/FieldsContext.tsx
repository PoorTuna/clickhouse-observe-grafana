import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { TimeRange } from '@grafana/data';
import { FieldModel, inferFieldType } from '../sql/fieldModel';
import { buildColumnsQuery, buildMapKeysQuery } from '../sql/introspection';
import { runQueryRows } from '../data/runQuery';
import { SourceConfig } from '../types';

// Module-level caches survive re-renders; cleared on explicit refresh().
const columnCache = new Map<string, FieldModel[]>();
const mapKeyCache = new Map<string, string[]>();

function columnCacheKey(config: SourceConfig, table: string): string {
  return `${config.datasourceUid}:${config.database}:${table}`;
}

function mapKeyCacheKey(config: SourceConfig, table: string, mapCol: string, bucket: string): string {
  return `${config.datasourceUid}:${config.database}:${table}:${mapCol}:${bucket}`;
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

const FieldsContext = createContext<FieldsContextValue>({
  fields: [],
  loading: false,
  error: null,
  refresh: () => {},
});

export function useFields(): FieldsContextValue {
  return useContext(FieldsContext);
}

interface FieldsProviderProps {
  config: SourceConfig;
  timeRange: TimeRange;
  /** Table to introspect. Defaults to config.logsTable (existing Logs behavior). */
  table?: string;
  /** Map(String,String) columns to expand into individual key fields. Defaults to the logs Map columns. */
  mapColumns?: string[];
  children: React.ReactNode;
}

export function FieldsProvider({ config, timeRange, table, mapColumns, children }: FieldsProviderProps) {
  const resolvedTable = table ?? config.logsTable;
  const resolvedMapColumns = useMemo(
    () =>
      mapColumns ?? [config.columns.resourceAttributes, config.columns.logAttributes, config.columns.scopeAttributes],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mapColumns, config.columns.resourceAttributes, config.columns.logAttributes, config.columns.scopeAttributes]
  );
  const [fields, setFields] = useState<FieldModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runRef = useRef(0);

  const bucket = useMemo(() => coarseTimeBucket(timeRange), [timeRange]);

  async function loadFields(invalidateColumns = false) {
    if (!config.datasourceUid) {
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

    // Phase B: Map keys (time-bounded, cached per table + coarse bucket)
    const mapCols = resolvedMapColumns.filter(Boolean);

    const mapFields: FieldModel[] = [];
    for (const mapCol of mapCols) {
      const mKey = mapKeyCacheKey(config, resolvedTable, mapCol, bucket);
      let keys: string[];
      if (mapKeyCache.has(mKey)) {
        keys = mapKeyCache.get(mKey)!;
      } else {
        try {
          const rows = await runQueryRows({
            datasourceUid: config.datasourceUid,
            sql: buildMapKeysQuery(config, mapCol, 500, resolvedTable),
            timeRange,
          });
          keys = rows.map((r) => String(r['k'] ?? '')).filter(Boolean);
          mapKeyCache.set(mKey, keys);
        } catch {
          keys = [];
        }
      }

      for (const k of keys) {
        mapFields.push({
          id: `map:${mapCol}:${k}`,
          name: k,
          displayName: k,
          sqlExpr: `${mapCol}['${k}']`,
          type: 'string',
          source: 'map',
          mapColumn: mapCol,
        });
      }
    }

    if (runRef.current === runId) {
      setFields([...columns, ...mapFields]);
      setLoading(false);
      setError(null);
    }
  }

  const refresh = () => loadFields(true);

  useEffect(() => {
    loadFields();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.datasourceUid, config.database, resolvedTable, bucket]);

  return (
    <FieldsContext.Provider value={{ fields, loading, error, refresh }}>
      {children}
    </FieldsContext.Provider>
  );
}
