import { useEffect, useMemo, useRef, useState } from 'react';
import { TimeRange } from '@grafana/data';
import { FieldModel } from '../sql/fieldModel';
import { FieldIndex } from '../sql/fields';
import { buildFieldPresenceQuery } from '../sql/presence';
import { runQueryRows } from '../data/runQuery';
import { LogsQueryState, SourceConfig } from '../types';

export type PresenceStatus = 'unknown' | 'ok' | 'failed';

export interface FieldPresence {
  /** FieldModel.id set of fields observed to have values in the sampled result set. `null` while
   *  the split hasn't been computed yet, or couldn't be (see `status`) — callers should treat
   *  `null` as "show everything", never as "nothing is present". */
  present: Set<string> | null;
  status: PresenceStatus;
  loading: boolean;
}

const UNKNOWN_PRESENCE: FieldPresence = { present: null, status: 'unknown', loading: false };

/**
 * Filter-aware Available/Empty split for the field sidebar (see FieldSidebar.tsx). Unlike field
 * *discovery* (useFieldDiscovery, schema/time-bucket scoped), this re-derives on every
 * search/filter change — same trigger set fetchVolume (LogsExplorer.tsx) already uses for the
 * histogram, so the sidebar's notion of "in scope" tracks what's on screen the same way the
 * histogram's bars do. See src/sql/presence.ts for the query itself.
 */
export function useFieldPresence(
  config: SourceConfig,
  timeRange: TimeRange,
  state: LogsQueryState,
  fields: FieldModel[],
  index?: FieldIndex
): FieldPresence {
  const [presence, setPresence] = useState<FieldPresence>(UNKNOWN_PRESENCE);
  const runRef = useRef(0);

  // Deliberately narrow — mirrors fetchVolume's deps in LogsExplorer.tsx: columns/sort/paging must
  // not re-fire this, only what actually changes the filtered result set.
  const cacheKey = useMemo(
    () =>
      JSON.stringify([
        config.datasourceUid,
        config.database,
        config.logsTable,
        state.search,
        state.filters,
        timeRange.raw,
        fields.map((f) => f.id),
      ]),
    [config.datasourceUid, config.database, config.logsTable, state.search, state.filters, timeRange, fields]
  );

  useEffect(() => {
    if (!config.datasourceUid || fields.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPresence(UNKNOWN_PRESENCE);
      return;
    }

    const query = (() => {
      try {
        return buildFieldPresenceQuery(config, state, fields, index);
      } catch {
        // buildWhereConditions can throw KqlSyntaxError on an unparseable search — the sidebar
        // just falls back to "show everything" rather than surfacing a second error banner
        // alongside the one SearchBar already shows for the same bad query.
        return null;
      }
    })();

    if (!query) {
      setPresence(UNKNOWN_PRESENCE);
      return;
    }

    const runId = ++runRef.current;
    setPresence((prev) => ({ ...prev, loading: true }));

    runQueryRows({ datasourceUid: config.datasourceUid, sql: query.sql, timeRange, refId: 'presence' })
      .then((rows) => {
        if (runRef.current !== runId) {
          return;
        }
        const row = rows[0] ?? {};
        const present = new Set<string>();

        for (const [fieldId, alias] of query.columnAliases) {
          if (Number(row[alias] ?? 0) > 0) {
            present.add(fieldId);
          }
        }

        const mapKeysByCol = new Map<string, Set<string>>();
        for (const [mapCol, alias] of query.mapKeyAliases) {
          mapKeysByCol.set(mapCol, new Set((row[alias] as string[] | undefined) ?? []));
        }
        const jsonPathsByCol = new Map<string, Set<string>>();
        for (const [jsonCol, alias] of query.jsonPathAliases) {
          jsonPathsByCol.set(jsonCol, new Set((row[alias] as string[] | undefined) ?? []));
        }

        for (const f of fields) {
          if (f.source === 'map' && f.mapColumn) {
            if (mapKeysByCol.get(f.mapColumn)?.has(f.name)) {
              present.add(f.id);
            }
          } else if (f.source === 'json' && f.jsonColumn) {
            if (jsonPathsByCol.get(f.jsonColumn)?.has(f.jsonPath ?? f.name)) {
              present.add(f.id);
            }
          } else if (!query.columnAliases.has(f.id)) {
            // Past MAX_PRESENCE_AGGREGATES — treated as present (see presence.ts).
            present.add(f.id);
          }
        }

        setPresence({ present, status: 'ok', loading: false });
      })
      .catch(() => {
        if (runRef.current === runId) {
          setPresence(UNKNOWN_PRESENCE);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  return presence;
}
