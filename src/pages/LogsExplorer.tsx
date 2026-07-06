import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { dateTime, GrafanaTheme2, PageLayoutType, TimeRange } from '@grafana/data';
import { PluginPage } from '@grafana/runtime';
import { Button, ClipboardButton, Icon, Spinner, Switch, useStyles2, TimeRangePicker } from '@grafana/ui';
import { SearchBar } from '../components/SearchBar';
import { FilterPills } from '../components/FilterPills';
import { LogsTable } from '../components/LogsTable';
import { LogDetailDrawer } from '../components/LogDetailDrawer';
import { VolumeHistogram, resolveInterval, ResolvedInterval } from '../components/VolumeHistogram';
import { IntervalPicker } from '../components/HistogramControls/IntervalPicker';
import { BreakdownPicker } from '../components/HistogramControls/BreakdownPicker';
import { FieldSidebar } from '../components/FieldSidebar/FieldSidebar';
import { FieldsProvider } from '../components/FieldsContext';
import { SavedSearchMenu } from '../components/SavedSearches/SavedSearchMenu';
import { PaginationBar } from '../components/PaginationBar';
import { DataViewPicker } from '../components/DataViewPicker/DataViewPicker';
import { AddToDashboardModal } from '../components/AddToDashboard/AddToDashboardModal';
import { canCreateDashboards } from '../utils/permissions';
import { runQueryRows } from '../data/runQuery';
import { buildLogsQuery, buildVolumeQuery, buildWhereConditions, resolveVolumeBreakdown, CORE_ALIAS } from '../sql/queryBuilder';
import { loadFieldValues } from '../sql/kql/_values';
import { addFilterPill } from '../sql/filters';
import { AddFilterPopover } from '../components/AddFilter/AddFilterPopover';
import { SourceConfigContext, DataViewContext } from '../components/App/App';
import { viewCapabilities } from '../sql/capabilities';
import {
  BreakdownSel,
  DEFAULT_LOGS_QUERY_STATE,
  FilterPill,
  IntervalMode,
  LogRow,
  LogsQueryState,
  SavedSearch,
  SelectedColumn,
  ColumnType,
  SourceConfig,
  VolumeDataPoint,
} from '../types';
import { PLUGIN_BASE_URL } from '../constants';
import { shiftTimeRange, zoomOutTimeRange } from '../utils/timeRangeNav';
import { useAvailableHeight } from '../utils/useAvailableHeight';

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

function defaultColumns(config: SourceConfig): SelectedColumn[] {
  const c = config.columns;
  // Only include columns for which a mapping exists. Empty mapping = column not present in this view.
  // `id` stays a stable plain name (used for React keys/reorder, unrelated to SQL); `key` must
  // match the __-prefixed alias buildLogsQuery actually emits (see CORE_ALIAS).
  const cols: Array<{ id: string; key: string; sqlExpr: string; displayName: string; type: ColumnType }> = [
    { id: 'timestamp', key: CORE_ALIAS.timestamp, sqlExpr: c.timestamp, displayName: 'Time', type: 'time' },
    { id: 'severity', key: CORE_ALIAS.severity, sqlExpr: c.severity, displayName: 'Level', type: 'level' },
    { id: 'serviceName', key: CORE_ALIAS.serviceName, sqlExpr: c.serviceName, displayName: 'Service', type: 'exact' },
    { id: 'body', key: CORE_ALIAS.body, sqlExpr: c.body, displayName: 'Message', type: 'text' },
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

  // Grafana's PageLayoutType.Custom chrome doesn't clamp to the viewport (see useAvailableHeight's
  // doc comment) — height:100% resolves against nothing, so without this the whole page scrolls
  // instead of just the log table. Same fix as TraceExplorer.tsx.
  const containerRef = useRef<HTMLDivElement>(null);
  const availableHeight = useAvailableHeight(containerRef);

  // Reset query state when the active data view changes so stale field refs don't carry over.
  const prevViewId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const viewId = activeView?.id;
    if (prevViewId.current !== undefined && prevViewId.current !== viewId) {
      dispatch({ type: 'LOAD_SAVED', state: DEFAULT_LOGS_QUERY_STATE });
      // Re-derive capabilities from the latest config (updates with activeView).
      const newCaps = viewCapabilities(config);
      setBreakdown(newCaps.hasSeverity ? { kind: 'severity' } : { kind: 'none' });
    }
    prevViewId.current = viewId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView?.id]);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [volumeData, setVolumeData] = useState<VolumeDataPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<LogRow | null>(null);

  // Histogram controls.
  // Breakdown initial value is set once at mount — no effect ever forces it back,
  // so user choices (including "No breakdown") always persist.
  const [intervalMode, setIntervalMode] = useState<IntervalMode>('auto');
  const [breakdown, setBreakdown] = useState<BreakdownSel>(() =>
    caps.hasSeverity ? { kind: 'severity' } : { kind: 'none' }
  );

  // Sidebar collapse
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showSqlInspect, setShowSqlInspect] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
  // Uncommitted raw-SQL textarea contents — kept local so typing never re-runs the query.
  // Only `runRawSql` (Run button / Ctrl+Enter) commits it to queryState.rawSql.
  const [rawSqlDraft, setRawSqlDraft] = useState('');
  const [addToDashboardOpen, setAddToDashboardOpen] = useState(false);
  const canAddToDashboard = useMemo(() => canCreateDashboards(), []);

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

  const resolvedInterval = useMemo<ResolvedInterval>(
    () => resolveInterval(intervalMode, timeRange),
    [intervalMode, timeRange]
  );

  const totalEvents = useMemo(
    () => volumeData.reduce((sum, d) => sum + Object.values(d.levels).reduce((a, b) => a + b, 0), 0),
    [volumeData]
  );

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
      // Fall back to the builder-generated query if rawSql is empty (e.g. raw mode was just
      // enabled and nothing has been explicitly run yet) — never send a blank query.
      const sql = queryState.useRawSql
        ? queryState.rawSql || buildLogsQuery(config, stateWithCols, { limit: INITIAL_FETCH, offset: 0 })
        : buildLogsQuery(config, stateWithCols, { limit: INITIAL_FETCH, offset: 0 });
      const resolved = resolveInterval(intervalMode, timeRange);
      const volSql = buildVolumeQuery(config, queryState, {
        interval: { unit: resolved.unit, value: resolved.value },
        breakdown: resolveVolumeBreakdown(breakdown, config),
      });

      const volPromise = caps.hasTime
        ? runQueryRows({ datasourceUid: config.datasourceUid, sql: volSql, timeRange, refId: 'vol' })
        : Promise.resolve<ReturnType<typeof Object>[]>([]);

      const [logRows, volRows] = await Promise.all([
        runQueryRows({ datasourceUid: config.datasourceUid, sql, timeRange, refId: 'logs' }),
        volPromise,
      ]);

      if (runRef.current !== runId) {
        return;
      }

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
  }, [config, queryState, timeRange, effectiveColumns, intervalMode, breakdown]);

  useLayoutEffect(() => {
    latestExecuteQuery.current = executeQuery;
  });

  // Tracks the previous useRawSql value so the auto-run effect below can tell "just switched
  // into raw mode" apart from any other queryState change.
  const prevUseRawSql = useRef(queryState.useRawSql);

  useEffect(() => {
    // Entering raw-SQL mode alone shouldn't fetch: the textarea is seeded with whatever query
    // is already on screen (see onToggleRawSql), so there's nothing new to run yet — only the
    // explicit Run button / Ctrl+Enter (runRawSql) should trigger a request from here on.
    const enteringRawMode = !prevUseRawSql.current && queryState.useRawSql;
    prevUseRawSql.current = queryState.useRawSql;
    if (enteringRawMode) {
      return;
    }
    executeQuery();
  }, [executeQuery, queryState.useRawSql]);

  const onAddFilter = (filter: FilterPill) => {
    dispatch({
      type: 'SET_FILTERS',
      filters: addFilterPill(queryState.filters, filter),
    });
  };

  const logsLoadValues = useCallback(
    (sqlExpr: string) =>
      loadFieldValues(config, sqlExpr, {
        table: config.logsTable,
        conditions: buildWhereConditions(config, queryState),
        timeRange,
        cacheKey: JSON.stringify([queryState.search, queryState.filters]),
      }),
    [config, queryState, timeRange]
  );

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

  // What the visual builder would produce right now — used for the "Inspect SQL" preview/copy
  // and as the seed value when switching into raw-SQL mode (see onToggleRawSql below).
  const builderSql = buildLogsQuery(config, { ...queryState, columns: effectiveColumns });

  const onToggleRawSql = () => {
    if (!queryState.useRawSql) {
      // Entering raw mode: show the last query that actually ran (custom SQL if one was run
      // before, otherwise the builder's current query) — never start from a blank textarea.
      setRawSqlDraft(queryState.rawSql || builderSql);
    }
    dispatch({ type: 'TOGGLE_RAW_SQL' });
  };

  const runRawSql = () => dispatch({ type: 'SET_RAW_SQL', sql: rawSqlDraft });

  const pageRows = useMemo(
    () => rows.slice(currentPage * pageSize, currentPage * pageSize + pageSize),
    [rows, currentPage, pageSize]
  );
  // Reference-equality lookup — pageRows are slices of the same row objects, so this holds
  // even across re-renders as long as selectedRow came from onRowClick(row).
  const selectedIndex = selectedRow ? pageRows.indexOf(selectedRow) : -1;

  return (
    <FieldsProvider config={config} timeRange={timeRange}>
      <PluginPage layout={PageLayoutType.Custom} pageNav={{ text: 'Logs' }}>
      <div ref={containerRef} className={styles.container} style={{ height: availableHeight }}>
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
            icon="apps"
            onClick={() => setAddToDashboardOpen(true)}
            disabled={!canAddToDashboard}
            tooltip={canAddToDashboard ? 'Add to dashboard' : 'You do not have permission to create dashboards'}
          >
            Add to dashboard
          </Button>
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
            loadValues={logsLoadValues}
          />
          <AddFilterPopover loadValues={logsLoadValues} onAddFilter={onAddFilter} />
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
              onClick={onToggleRawSql}
              title={
                queryState.useRawSql
                  ? 'Discard raw SQL and go back to the visual query builder'
                  : 'For regex, ClickHouse functions, and other advanced queries, switch to raw SQL'
              }
            >
              <Icon name={queryState.useRawSql ? 'angle-down' : 'angle-right'} size="xs" />
              {queryState.useRawSql ? 'Back to query builder' : 'Edit as SQL'}
            </button>
            <button
              className={styles.sqlToggle}
              onClick={() => setShowSqlInspect((v) => !v)}
              title="Inspect the SQL query that will be sent to ClickHouse"
            >
              <Icon name={showSqlInspect ? 'angle-down' : 'angle-right'} size="xs" />
              {showSqlInspect ? 'Hide SQL' : 'Inspect SQL'}
            </button>
          </div>
          {queryState.useRawSql && (
            <>
              <textarea
                className={styles.sqlEditor}
                value={rawSqlDraft}
                onChange={(e) => setRawSqlDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    runRawSql();
                  }
                }}
                rows={6}
              />
              <div className={styles.sqlRunRow}>
                <Button size="sm" variant="primary" onClick={runRawSql}>
                  Run query
                </Button>
                <span className={styles.sqlRunHint}>Ctrl+Enter</span>
              </div>
            </>
          )}
          {showSqlInspect && !queryState.useRawSql && (
            <div className={styles.sqlInspect}>
              <pre className={styles.sqlInspectPre}>{builderSql}</pre>
              <ClipboardButton
                className={styles.sqlCopyBtn}
                size="sm"
                variant="secondary"
                icon="clipboard-alt"
                getText={() => builderSql}
              >
                Copy
              </ClipboardButton>
            </div>
          )}
        </div>

        {/* Error banner */}
        {error && (
          <div className={styles.error}>
            <strong>Query error:</strong> {error}
          </div>
        )}

        {/* Histogram panel: header (controls + meta) + chart in one bordered card */}
        {caps.hasTime && (
          <div className={styles.histogramPanel}>
            <div className={styles.histogramHeader}>
              <IntervalPicker
                value={intervalMode}
                onChange={setIntervalMode}
                timeRange={timeRange}
              />
              <BreakdownPicker
                value={breakdown}
                onChange={setBreakdown}
                hasSeverity={caps.hasSeverity}
              />
              <div className={styles.histogramHeaderSpacer} />
              {volumeData.length > 0 && (
                <span className={styles.histogramMeta}>
                  {totalEvents.toLocaleString()} events &middot; interval: {resolvedInterval.label}
                </span>
              )}
            </div>
            {volumeData.length > 0 ? (
              <VolumeHistogram
                data={volumeData}
                timeRange={timeRange}
                onSelectRange={onHistogramSelectRange}
                colorMode={
                  breakdown.kind === 'field'
                    ? 'breakdown'
                    : breakdown.kind === 'severity'
                    ? 'severity'
                    : 'single'
                }
                bucketMs={resolvedInterval.intervalMs}
              />
            ) : (
              <div className={styles.histogramEmpty}>
                {loading ? 'Loading…' : 'No events in selected time range'}
              </div>
            )}
          </div>
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
            {/* Only overlay when we already have rows to show underneath (a refetch) —
                the initial-load case is handled by LogsTable's own loading state, so the
                two never show at once. */}
            {loading && rows.length > 0 && (
              <div className={styles.loadingOverlay}>
                <div className={styles.loadingContent}>
                  <Spinner size="xl" />
                  <span className={styles.loadingText}>Running query…</span>
                </div>
              </div>
            )}
            <div className={styles.tableToolbar}>
              <div className={styles.headerSpacer} />
              <label className={styles.wrapToggleLabel}>
                <Switch value={wrapLines} onChange={(e) => setWrapLines(e.currentTarget.checked)} />
                Wrap lines
              </label>
            </div>
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
              wrapLines={wrapLines}
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
            columns={effectiveColumns}
            onClose={() => setSelectedRow(null)}
            onAddFilter={(f) => {
              onAddFilter(f);
              setSelectedRow(null);
            }}
            onToggleColumn={onToggleColumn}
            onViewTrace={
              caps.hasTraces && selectedRow[CORE_ALIAS.traceId]
                ? (traceId) => {
                    window.location.href = `${PLUGIN_BASE_URL}/traces/${traceId}`;
                  }
                : undefined
            }
            onPrev={selectedIndex > 0 ? () => setSelectedRow(pageRows[selectedIndex - 1]) : undefined}
            onNext={
              selectedIndex >= 0 && selectedIndex < pageRows.length - 1
                ? () => setSelectedRow(pageRows[selectedIndex + 1])
                : undefined
            }
            navLabel={selectedIndex >= 0 ? `${selectedIndex + 1} of ${pageRows.length}` : undefined}
          />
        )}

        <AddToDashboardModal
          isOpen={addToDashboardOpen}
          onDismiss={() => setAddToDashboardOpen(false)}
          config={config}
          queryState={{ ...queryState, columns: effectiveColumns }}
          breakdown={breakdown}
          caps={caps}
        />
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
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
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
  sqlRunRow: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  sqlRunHint: css`
    font-size: 11px;
    color: ${theme.colors.text.disabled};
  `,
  error: css`
    padding: ${theme.spacing(1)};
    background: ${theme.colors.error.transparent};
    border: 1px solid ${theme.colors.error.border};
    border-radius: ${theme.shape.radius.default};
    color: ${theme.colors.error.text};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  histogramPanel: css`
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
  `,
  histogramEmpty: css`
    height: 64px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: ${theme.colors.text.disabled};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  histogramHeader: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(0.75)} ${theme.spacing(1)};
    border-bottom: 1px solid ${theme.colors.border.weak};
  `,
  histogramHeaderSpacer: css`
    flex: 1;
  `,
  histogramMeta: css`
    font-size: 11px;
    color: ${theme.colors.text.disabled};
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
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
  tableToolbar: css`
    display: flex;
    align-items: center;
    padding-bottom: ${theme.spacing(0.5)};
  `,
  wrapToggleLabel: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    cursor: pointer;
    white-space: nowrap;
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
