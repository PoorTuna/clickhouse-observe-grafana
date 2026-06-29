import React, { useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { dateTime, GrafanaTheme2, TimeRange } from '@grafana/data';
import { Button, Spinner, useStyles2, TimeRangePicker } from '@grafana/ui';
import { SearchBar } from '../components/SearchBar';
import { FilterPills } from '../components/FilterPills';
import { LogsTable } from '../components/LogsTable';
import { LogDetailDrawer } from '../components/LogDetailDrawer';
import { VolumeHistogram, calcBucketInterval } from '../components/VolumeHistogram';
import { FieldSidebar } from '../components/FieldSidebar/FieldSidebar';
import { FieldsProvider } from '../components/FieldsContext';
import { SavedSearchMenu } from '../components/SavedSearches/SavedSearchMenu';
import { runQueryRows } from '../data/runQuery';
import { buildLogsQuery, buildVolumeQuery } from '../sql/queryBuilder';
import { addFilter } from '../sql/filters';
import { SourceConfigContext } from '../components/App/App';
import {
  DEFAULT_LOGS_QUERY_STATE,
  FilterPill,
  LogRow,
  LogsQueryState,
  SavedSearch,
  SelectedColumn,
  ColumnType,
  VolumeDataPoint,
} from '../types';
import { PLUGIN_BASE_URL } from '../constants';

function defaultTimeRange(): TimeRange {
  return {
    from: dateTime(Date.now() - 3600 * 1000),
    to: dateTime(Date.now()),
    raw: { from: 'now-1h', to: 'now' },
  };
}

function defaultColumns(config: ReturnType<typeof useContext<any>>): SelectedColumn[] {
  const c = config.columns;
  const cols: Array<{ id: string; key: string; sqlExpr: string; displayName: string; type: ColumnType }> = [
    { id: 'timestamp', key: 'timestamp', sqlExpr: c.timestamp, displayName: 'Time', type: 'time' },
    { id: 'severity', key: 'severity', sqlExpr: c.severity || "''", displayName: 'Level', type: 'level' },
    { id: 'body', key: 'body', sqlExpr: c.body, displayName: 'Message', type: 'text' },
    { id: 'serviceName', key: 'serviceName', sqlExpr: c.serviceName || "''", displayName: 'Service', type: 'exact' },
  ];
  return cols
    .filter((col) => Boolean(col.sqlExpr))
    .map((col) => ({ ...col, isCore: true }));
}

type Action =
  | { type: 'SET_SEARCH'; value: string }
  | { type: 'SET_FILTERS'; filters: FilterPill[] }
  | { type: 'TOGGLE_RAW_SQL' }
  | { type: 'SET_RAW_SQL'; sql: string }
  | { type: 'ADD_COLUMN'; col: SelectedColumn }
  | { type: 'REMOVE_COLUMN'; id: string }
  | { type: 'REORDER_COLUMN'; id: string; direction: 'left' | 'right' }
  | { type: 'SET_SORT'; col: string }
  | { type: 'LOAD_SAVED'; state: Partial<LogsQueryState> };

function queryReducer(state: LogsQueryState, action: Action): LogsQueryState {
  switch (action.type) {
    case 'SET_SEARCH':
      return { ...state, search: action.value };
    case 'SET_FILTERS':
      return { ...state, filters: action.filters };
    case 'TOGGLE_RAW_SQL':
      return { ...state, useRawSql: !state.useRawSql };
    case 'SET_RAW_SQL':
      return { ...state, rawSql: action.sql };
    case 'ADD_COLUMN': {
      if (state.columns.some((c) => c.id === action.col.id)) {
        return state;
      }
      return { ...state, columns: [...state.columns, action.col] };
    }
    case 'REMOVE_COLUMN':
      return { ...state, columns: state.columns.filter((c) => c.id !== action.id) };
    case 'REORDER_COLUMN': {
      const idx = state.columns.findIndex((c) => c.id === action.id);
      if (idx === -1) {
        return state;
      }
      const next = [...state.columns];
      const swapIdx = action.direction === 'left' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= next.length) {
        return state;
      }
      [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
      return { ...state, columns: next };
    }
    case 'SET_SORT': {
      const current = state.sort;
      const dir: 'asc' | 'desc' =
        current?.col === action.col && current.dir === 'desc' ? 'asc' : 'desc';
      return { ...state, sort: { col: action.col, dir } };
    }
    case 'LOAD_SAVED':
      return { ...state, ...action.state };
    default:
      return state;
  }
}

export function LogsExplorer() {
  const styles = useStyles2(getStyles);
  const config = useContext(SourceConfigContext);

  const [queryState, dispatch] = useReducer(queryReducer, DEFAULT_LOGS_QUERY_STATE);
  const [timeRange, setTimeRange] = useState<TimeRange>(defaultTimeRange);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [volumeData, setVolumeData] = useState<VolumeDataPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<LogRow | null>(null);

  const runRef = useRef(0);

  // Effective columns: use state if set, else derive defaults from config
  const effectiveColumns = useMemo<SelectedColumn[]>(() => {
    return queryState.columns.length > 0 ? queryState.columns : defaultColumns(config);
  }, [queryState.columns, config]);

  const executeQuery = useCallback(async () => {
    if (!config.datasourceUid) {
      setError('No ClickHouse datasource configured. Go to Configuration to set it up.');
      return;
    }
    const runId = ++runRef.current;
    setLoading(true);
    setError(null);

    try {
      const stateWithCols: LogsQueryState = {
        ...queryState,
        columns: effectiveColumns,
      };
      const sql = queryState.useRawSql
        ? queryState.rawSql
        : buildLogsQuery(config, stateWithCols);
      const intervalSec = calcBucketInterval(timeRange);
      const volSql = buildVolumeQuery(config, queryState, intervalSec);

      const [logRows, volRows] = await Promise.all([
        runQueryRows({ datasourceUid: config.datasourceUid, sql, timeRange }),
        runQueryRows({ datasourceUid: config.datasourceUid, sql: volSql, timeRange }),
      ]);

      if (runRef.current !== runId) {
        return;
      }

      setRows(logRows);

      const volMap = new Map<number, Record<string, number>>();
      for (const r of volRows) {
        const t = typeof r['time'] === 'number' ? r['time'] : Number(r['time'] ?? 0);
        const level = String(r['level'] ?? 'unknown').toLowerCase();
        const count = Number(r['count'] ?? 0);
        if (!volMap.has(t)) {
          volMap.set(t, {});
        }
        volMap.get(t)![level] = (volMap.get(t)![level] ?? 0) + count;
      }
      const volPoints: VolumeDataPoint[] = Array.from(volMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([time, levels]) => ({ time, levels }));
      setVolumeData(volPoints);
    } catch (err) {
      if (runRef.current === runId) {
        setError(String((err as Error)?.message ?? err));
      }
    } finally {
      if (runRef.current === runId) {
        setLoading(false);
      }
    }
  }, [config, queryState, timeRange, effectiveColumns]);

  useEffect(() => {
    executeQuery();
  }, [executeQuery]);

  const onAddFilter = (filter: FilterPill) => {
    dispatch({
      type: 'SET_FILTERS',
      filters: addFilter(queryState.filters, filter.field, filter.value, filter.op),
    });
  };

  const onToggleColumn = (col: SelectedColumn) => {
    if (effectiveColumns.some((c) => c.id === col.id)) {
      dispatch({ type: 'REMOVE_COLUMN', id: col.id });
    } else {
      dispatch({ type: 'ADD_COLUMN', col });
    }
  };

  const onLoadSaved = (search: SavedSearch, newTimeRange?: TimeRange) => {
    dispatch({
      type: 'LOAD_SAVED',
      state: {
        search: search.search,
        filters: search.filters,
        columns: search.columns,
        sort: search.sort,
      },
    });
    if (newTimeRange) {
      setTimeRange(newTimeRange);
    }
  };

  const onHistogramSelectRange = (fromMs: number, toMs: number) => {
    setTimeRange({
      from: dateTime(fromMs),
      to: dateTime(toMs),
      raw: { from: dateTime(fromMs), to: dateTime(toMs) },
    });
  };

  const effectiveSql = queryState.useRawSql
    ? queryState.rawSql
    : buildLogsQuery(config, { ...queryState, columns: effectiveColumns });

  return (
    <FieldsProvider config={config} timeRange={timeRange}>
      <div className={styles.container}>
        {/* Header */}
        <div className={styles.header}>
          <h2 className={styles.title}>Logs Explorer</h2>
          <SavedSearchMenu
            queryState={{ ...queryState, columns: effectiveColumns }}
            timeRange={timeRange}
            onLoad={onLoadSaved}
          />
          <TimeRangePicker
            value={timeRange}
            onChange={(range) => setTimeRange(range)}
            onChangeTimeZone={() => {}}
            onChangeFiscalYearStartMonth={() => {}}
            onMoveBackward={() => {}}
            onMoveForward={() => {}}
            onZoom={() => {}}
            timeZone="browser"
            fiscalYearStartMonth={0}
          />
          <Button
            variant="secondary"
            size="sm"
            icon="sync"
            onClick={executeQuery}
            disabled={loading}
            tooltip="Refresh"
          />
        </div>

        {/* Toolbar */}
        <div className={styles.toolbar}>
          <SearchBar
            value={queryState.search}
            onChange={(v) => dispatch({ type: 'SET_SEARCH', value: v })}
            onSearch={() => executeQuery()}
            onAddFilter={onAddFilter}
          />
        </div>

        {/* Filter pills */}
        {queryState.filters.length > 0 && (
          <div className={styles.pills}>
            <FilterPills
              filters={queryState.filters}
              onChange={(f) => dispatch({ type: 'SET_FILTERS', filters: f })}
            />
          </div>
        )}

        {/* SQL preview / edit */}
        <div className={styles.sqlRow}>
          <button
            className={styles.sqlToggle}
            onClick={() => dispatch({ type: 'TOGGLE_RAW_SQL' })}
          >
            {queryState.useRawSql ? '▾ Edit SQL' : '▸ Edit as SQL'}
          </button>
          {queryState.useRawSql && (
            <textarea
              className={styles.sqlEditor}
              value={queryState.rawSql || effectiveSql}
              onChange={(e) => dispatch({ type: 'SET_RAW_SQL', sql: e.target.value })}
              rows={6}
            />
          )}
        </div>

        {/* Error banner */}
        {error && (
          <div className={styles.error}>
            <strong>Query error:</strong> {error}
          </div>
        )}

        {/* Volume histogram */}
        {volumeData.length > 0 && (
          <VolumeHistogram
            data={volumeData}
            timeRange={timeRange}
            onSelectRange={onHistogramSelectRange}
          />
        )}

        {/* Two-pane: sidebar + results */}
        <div className={styles.body}>
          <FieldSidebar
            queryState={{ ...queryState, columns: effectiveColumns }}
            timeRange={timeRange}
            onToggleColumn={onToggleColumn}
            onAddFilter={onAddFilter}
          />

          <div className={styles.results}>
            {loading && (
              <div className={styles.loadingOverlay}>
                <Spinner />
              </div>
            )}
            <LogsTable
              rows={rows}
              loading={loading && rows.length === 0}
              columns={effectiveColumns}
              sort={queryState.sort}
              onRowClick={setSelectedRow}
              onSort={(col) => dispatch({ type: 'SET_SORT', col })}
              onRemoveColumn={(col) => dispatch({ type: 'REMOVE_COLUMN', id: col.id })}
              onMoveColumn={(id, direction) => dispatch({ type: 'REORDER_COLUMN', id, direction })}
              selectedRow={selectedRow}
            />
          </div>
        </div>

        {/* Detail drawer */}
        {selectedRow && (
          <LogDetailDrawer
            row={selectedRow}
            config={config}
            onClose={() => setSelectedRow(null)}
            onAddFilter={(f) => {
              onAddFilter(f);
              setSelectedRow(null);
            }}
            onViewTrace={
              selectedRow['traceId']
                ? (traceId) => {
                    window.location.href = `${PLUGIN_BASE_URL}/traces/${traceId}`;
                  }
                : undefined
            }
          />
        )}
      </div>
    </FieldsProvider>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: ${theme.spacing(2)};
    gap: ${theme.spacing(1)};
    background: ${theme.colors.background.canvas};
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    flex-wrap: wrap;
  `,
  title: css`
    font-size: ${theme.typography.h4.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
    margin: 0;
    flex: 1;
  `,
  toolbar: css`
    display: flex;
    gap: ${theme.spacing(1)};
    align-items: center;
  `,
  pills: css`
    min-height: 0;
  `,
  sqlRow: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.5)};
  `,
  sqlToggle: css`
    background: transparent;
    border: none;
    cursor: pointer;
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    text-align: left;
    padding: 0;
    &:hover { color: ${theme.colors.text.primary}; }
  `,
  sqlEditor: css`
    width: 100%;
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(1)};
    color: ${theme.colors.text.primary};
    resize: vertical;
    outline: none;
  `,
  error: css`
    padding: ${theme.spacing(1)};
    background: ${theme.colors.error.transparent};
    border: 1px solid ${theme.colors.error.border};
    border-radius: ${theme.shape.radius.default};
    color: ${theme.colors.error.text};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  body: css`
    flex: 1;
    min-height: 0;
    display: flex;
    gap: ${theme.spacing(1.5)};
    overflow: hidden;
  `,
  results: css`
    flex: 1;
    min-height: 0;
    min-width: 0;
    position: relative;
    display: flex;
    flex-direction: column;
  `,
  loadingOverlay: css`
    position: absolute;
    top: ${theme.spacing(1)};
    right: ${theme.spacing(1)};
    z-index: 2;
  `,
});
