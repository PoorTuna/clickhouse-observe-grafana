import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { dateTime, GrafanaTheme2, PageLayoutType, TimeRange } from '@grafana/data';
import { PluginPage } from '@grafana/runtime';
import { Button, Icon, Spinner, useStyles2, TimeRangePicker } from '@grafana/ui';
import { SearchBar } from '../components/SearchBar';
import { FilterPills } from '../components/FilterPills';
import { LogsTable } from '../components/LogsTable';
import { LogDetailDrawer } from '../components/LogDetailDrawer';
import { VolumeHistogram, calcBucketInterval } from '../components/VolumeHistogram';
import { FieldSidebar } from '../components/FieldSidebar/FieldSidebar';
import { FieldsProvider } from '../components/FieldsContext';
import { SavedSearchMenu } from '../components/SavedSearches/SavedSearchMenu';
import { PaginationBar } from '../components/PaginationBar';
import { DataViewPicker } from '../components/DataViewPicker/DataViewPicker';
import { runQueryRows } from '../data/runQuery';
import { buildLogsQuery, buildVolumeQuery } from '../sql/queryBuilder';
import { addFilterPill } from '../sql/filters';
import { AddFilterPopover } from '../components/AddFilter/AddFilterPopover';
import { SourceConfigContext, DataViewContext } from '../components/App/App';
import { viewCapabilities } from '../sql/capabilities';
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
import { shiftTimeRange, zoomOutTimeRange } from '../utils/timeRangeNav';

const INITIAL_FETCH = 200;
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 250, 500];
const DEFAULT_PAGE_SIZE = 50;

function defaultTimeRange(): TimeRange {
  return {
    from: dateTime(Date.now() - 3600 * 1000),
    to: dateTime(Date.now()),
    raw: { from: 'now-1h', to: 'now' },
  };
}

function defaultColumns(config: ReturnType<typeof useContext<any>>): SelectedColumn[] {
  const c = config.columns;
  // Only include columns for which a mapping exists. Empty mapping = column not present in this view.
  const cols: Array<{ id: string; key: string; sqlExpr: string; displayName: string; type: ColumnType }> = [
    { id: 'timestamp', key: 'timestamp', sqlExpr: c.timestamp, displayName: 'Time', type: 'time' },
    { id: 'severity', key: 'severity', sqlExpr: c.severity, displayName: 'Level', type: 'level' },
    { id: 'serviceName', key: 'serviceName', sqlExpr: c.serviceName, displayName: 'Service', type: 'exact' },
    { id: 'body', key: 'body', sqlExpr: c.body, displayName: 'Message', type: 'text' },
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
  const { activeView } = useContext(DataViewContext);
  const caps = viewCapabilities(config);

  const [queryState, dispatch] = useReducer(queryReducer, DEFAULT_LOGS_QUERY_STATE);
  const [timeRange, setTimeRange] = useState<TimeRange>(defaultTimeRange);

  // Reset query state when the active data view changes so stale field refs don't carry over.
  const prevViewId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const viewId = activeView?.id;
    if (prevViewId.current !== undefined && prevViewId.current !== viewId) {
      dispatch({ type: 'LOAD_SAVED', state: DEFAULT_LOGS_QUERY_STATE });
    }
    prevViewId.current = viewId;
  }, [activeView?.id]);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [volumeData, setVolumeData] = useState<VolumeDataPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<LogRow | null>(null);

  // Sidebar collapse
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showSqlInspect, setShowSqlInspect] = useState(false);
  const [sqlCopied, setSqlCopied] = useState(false);

  // Pagination
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [currentPage, setCurrentPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [fetchingMore, setFetchingMore] = useState(false);

  const runRef = useRef(0);
  // Always tracks the latest executeQuery closure so deferred calls get fresh state.
  const latestExecuteQuery = useRef<() => void>(() => {});

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
    console.debug('[LogsExplorer] executeQuery runId=%d search=%o', runId, queryState.search);
    setLoading(true);
    setError(null);

    try {
      const stateWithCols: LogsQueryState = {
        ...queryState,
        columns: effectiveColumns,
      };
      const sql = queryState.useRawSql
        ? queryState.rawSql
        : buildLogsQuery(config, stateWithCols, { limit: INITIAL_FETCH, offset: 0 });
      const intervalSec = calcBucketInterval(timeRange);
      const volSql = buildVolumeQuery(config, queryState, intervalSec);

      const volPromise = caps.hasTime
        ? runQueryRows({ datasourceUid: config.datasourceUid, sql: volSql, timeRange, refId: 'vol' })
        : Promise.resolve<ReturnType<typeof Object>[]>([]);

      const [logRows, volRows] = await Promise.all([
        runQueryRows({ datasourceUid: config.datasourceUid, sql, timeRange, refId: 'logs' }),
        volPromise,
      ]);

      if (runRef.current !== runId) {
        console.debug('[LogsExplorer] runId=%d DISCARDED (current=%d)', runId, runRef.current);
        return;
      }

      console.debug('[LogsExplorer] runId=%d ACCEPTED rows=%d', runId, logRows.length);
      setRows(logRows);
      setCurrentPage(0);
      setHasMore(!queryState.useRawSql && logRows.length === INITIAL_FETCH);

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

  useLayoutEffect(() => {
    latestExecuteQuery.current = executeQuery;
  });

  useEffect(() => {
    executeQuery();
  }, [executeQuery]);

  const onAddFilter = (filter: FilterPill) => {
    dispatch({
      type: 'SET_FILTERS',
      filters: addFilterPill(queryState.filters, filter),
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
        useRawSql: false, // always exit raw SQL mode when loading a saved search
      },
    });
    if (newTimeRange) {
      setTimeRange(newTimeRange);
    }
    // useLayoutEffect keeps latestExecuteQuery.current in sync with every render,
    // so by the time this microtask fires React has committed the new state and
    // the ref holds the fresh closure — guaranteeing results load without a manual click.
    queueMicrotask(() => latestExecuteQuery.current());
  };

  const onHistogramSelectRange = (fromMs: number, toMs: number) => {
    setTimeRange({
      from: dateTime(fromMs),
      to: dateTime(toMs),
      raw: { from: dateTime(fromMs), to: dateTime(toMs) },
    });
  };

  // Lazy-fetch rows beyond the initial buffer when the user pages past it.
  const ensureRows = useCallback(
    async (page: number, currentPageSize: number, currentRows: LogRow[], currentHasMore: boolean) => {
      const needed = (page + 1) * currentPageSize;
      if (currentRows.length >= needed || !currentHasMore || queryState.useRawSql) {
        return currentRows;
      }
      if (!config.datasourceUid) {
        return currentRows;
      }

      setFetchingMore(true);
      const runId = runRef.current;
      try {
        const stateWithCols: LogsQueryState = {
          ...queryState,
          columns: effectiveColumns,
        };
        const chunkSize = needed - currentRows.length;
        const sql = buildLogsQuery(config, stateWithCols, {
          limit: chunkSize,
          offset: currentRows.length,
        });
        const chunk = await runQueryRows({ datasourceUid: config.datasourceUid, sql, timeRange });
        if (runRef.current !== runId) {
          return currentRows;
        }
        const merged = [...currentRows, ...chunk];
        setRows(merged);
        setHasMore(chunk.length === chunkSize);
        return merged;
      } catch {
        return currentRows;
      } finally {
        setFetchingMore(false);
      }
    },
    [config, queryState, timeRange, effectiveColumns]
  );

  const onPageChange = useCallback(
    async (page: number) => {
      const runIdAtStart = runRef.current;
      const updated = await ensureRows(page, pageSize, rows, hasMore);
      // Abort if a new query started while we were fetching — stale setCurrentPage
      // would leave currentPage=N with the new (shorter) rows, making pageRows empty.
      if (runRef.current !== runIdAtStart) {
        return;
      }
      const needed = (page + 1) * pageSize;
      if (updated.length > page * pageSize || needed <= updated.length) {
        setCurrentPage(page);
      }
    },
    [ensureRows, pageSize, rows, hasMore]
  );

  const onPageSizeChange = useCallback((size: number) => {
    setPageSize(size);
    setCurrentPage(0);
  }, []);

  const effectiveSql = queryState.useRawSql
    ? queryState.rawSql
    : buildLogsQuery(config, { ...queryState, columns: effectiveColumns });

  const pageRows = useMemo(
    () => rows.slice(currentPage * pageSize, currentPage * pageSize + pageSize),
    [rows, currentPage, pageSize]
  );

  return (
    <FieldsProvider config={config} timeRange={timeRange}>
      <PluginPage layout={PageLayoutType.Custom} pageNav={{ text: 'Logs' }}>
      <div className={styles.container}>
        {/* Row 1: view picker (left) + controls (right) */}
        <div className={styles.header}>
          <DataViewPicker />
          <div className={styles.headerSpacer} />
          <SavedSearchMenu
            queryState={{ ...queryState, columns: effectiveColumns }}
            timeRange={timeRange}
            onLoad={onLoadSaved}
            activeDataViewId={activeView?.id}
          />
          {caps.hasTime && (
            <TimeRangePicker
              value={timeRange}
              onChange={(range) => setTimeRange(range)}
              onChangeTimeZone={() => {}}
              onChangeFiscalYearStartMonth={() => {}}
              onMoveBackward={() => setTimeRange(shiftTimeRange(timeRange, -1))}
              onMoveForward={() => setTimeRange(shiftTimeRange(timeRange, 1))}
              onZoom={() => setTimeRange(zoomOutTimeRange(timeRange))}
              timeZone="browser"
              fiscalYearStartMonth={0}
            />
          )}
          <Button
            variant="secondary"
            size="sm"
            icon="sync"
            onClick={executeQuery}
            disabled={loading}
            tooltip="Refresh"
          />
        </div>

        {/* Row 2: search + add filter */}
        <div className={styles.toolbar}>
          <SearchBar
            value={queryState.search}
            onChange={(v) => dispatch({ type: 'SET_SEARCH', value: v })}
            onSearch={() => {}}
            onAddFilter={onAddFilter}
            timeRange={timeRange}
            queryState={queryState}
          />
          <AddFilterPopover
            queryState={queryState}
            timeRange={timeRange}
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
          <div className={styles.sqlActions}>
            <button
              className={styles.sqlToggle}
              onClick={() => dispatch({ type: 'TOGGLE_RAW_SQL' })}
              title="For regex, ClickHouse functions, and other advanced queries, switch to raw SQL"
            >
              {queryState.useRawSql ? '▾ Edit SQL' : '▸ Edit as SQL'}
            </button>
            <button
              className={styles.sqlToggle}
              onClick={() => setShowSqlInspect((v) => !v)}
              title="Inspect the SQL query that will be sent to ClickHouse"
            >
              {showSqlInspect ? '▾ Hide SQL' : '▸ Inspect SQL'}
            </button>
          </div>
          {queryState.useRawSql && (
            <textarea
              className={styles.sqlEditor}
              value={queryState.rawSql || effectiveSql}
              onChange={(e) => dispatch({ type: 'SET_RAW_SQL', sql: e.target.value })}
              rows={6}
            />
          )}
          {showSqlInspect && !queryState.useRawSql && (
            <div className={styles.sqlInspect}>
              <pre className={styles.sqlInspectPre}>{effectiveSql}</pre>
              <button
                className={styles.sqlCopyBtn}
                onClick={() => {
                  navigator.clipboard.writeText(effectiveSql).then(() => {
                    setSqlCopied(true);
                    setTimeout(() => setSqlCopied(false), 2000);
                  });
                }}
              >
                {sqlCopied ? 'Copied!' : 'Copy'}
              </button>
            </div>
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
          {sidebarCollapsed ? (
            <div className={styles.sidebarRail}>
              <button
                className={styles.railBtn}
                title="Show fields"
                onClick={() => setSidebarCollapsed(false)}
              >
                <Icon name="angle-right" size="sm" />
              </button>
            </div>
          ) : (
            <FieldSidebar
              queryState={{ ...queryState, columns: effectiveColumns }}
              timeRange={timeRange}
              onToggleColumn={onToggleColumn}
              onAddFilter={onAddFilter}
              onCollapse={() => setSidebarCollapsed(true)}
            />
          )}

          <div className={styles.results}>
            {loading && (
              <div className={styles.loadingOverlay}>
                <div className={styles.loadingContent}>
                  <Spinner size="xl" />
                  <span className={styles.loadingText}>Running query…</span>
                </div>
              </div>
            )}
            <LogsTable
              rows={pageRows}
              loading={loading && rows.length === 0}
              columns={effectiveColumns}
              sort={queryState.sort}
              onRowClick={setSelectedRow}
              onSort={(col) => dispatch({ type: 'SET_SORT', col })}
              onRemoveColumn={(col) => dispatch({ type: 'REMOVE_COLUMN', id: col.id })}
              onMoveColumn={(id, direction) => dispatch({ type: 'REORDER_COLUMN', id, direction })}
              selectedRow={selectedRow}
            />
            <PaginationBar
              page={currentPage}
              pageSize={pageSize}
              pageSizeOptions={PAGE_SIZE_OPTIONS}
              totalLoaded={rows.length}
              hasMore={hasMore}
              fetchingMore={fetchingMore}
              onPageChange={onPageChange}
              onPageSizeChange={onPageSizeChange}
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
              caps.hasTraces && selectedRow['traceId']
                ? (traceId) => {
                    window.location.href = `${PLUGIN_BASE_URL}/traces/${traceId}`;
                  }
                : undefined
            }
          />
        )}
      </div>
      </PluginPage>
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
  `,
  headerSpacer: css`
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
  sqlActions: css`
    display: flex;
    gap: ${theme.spacing(2)};
    align-items: center;
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
  sqlInspect: css`
    position: relative;
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(1)};
  `,
  sqlInspectPre: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.primary};
    margin: 0;
    white-space: pre-wrap;
    word-break: break-all;
    padding-right: ${theme.spacing(7)};
  `,
  sqlCopyBtn: css`
    position: absolute;
    top: ${theme.spacing(1)};
    right: ${theme.spacing(1)};
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    cursor: pointer;
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    padding: ${theme.spacing(0.25)} ${theme.spacing(1)};
    &:hover { color: ${theme.colors.text.primary}; background: ${theme.colors.action.hover}; }
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
  sidebarRail: css`
    width: 28px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: ${theme.spacing(0.5)};
    border-right: 1px solid ${theme.colors.border.weak};
  `,
  railBtn: css`
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 4px;
    color: ${theme.colors.text.secondary};
    border-radius: ${theme.shape.radius.default};
    display: flex;
    align-items: center;
    &:hover {
      color: ${theme.colors.text.primary};
      background: ${theme.colors.action.hover};
    }
  `,
  loadingOverlay: css`
    position: absolute;
    inset: 0;
    z-index: 10;
    background: ${theme.colors.background.canvas}CC;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: ${theme.shape.radius.default};
  `,
  loadingContent: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: ${theme.spacing(1.5)};
  `,
  loadingText: css`
    font-size: ${theme.typography.body.fontSize};
    color: ${theme.colors.text.secondary};
  `,
});
