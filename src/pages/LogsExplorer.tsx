import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { css, cx } from '@emotion/css';
import { dateTime, GrafanaTheme2, PageLayoutType, TimeRange } from '@grafana/data';
import { PluginPage } from '@grafana/runtime';
import { Button, ClipboardButton, Icon, Spinner, Switch, useStyles2, TimeRangePicker, useSplitter } from '@grafana/ui';
import { SearchBar } from '../components/SearchBar';
import { FilterPills } from '../components/FilterPills';
import { LogsTable } from '../components/LogsTable';
import { LogDetailDrawer } from '../components/LogDetailDrawer';
import { VolumeHistogram, resolveInterval, ResolvedInterval, fillEmptyBuckets } from '../components/VolumeHistogram';
import { IntervalPicker } from '../components/HistogramControls/IntervalPicker';
import { BreakdownPicker } from '../components/HistogramControls/BreakdownPicker';
import { FieldSidebar } from '../components/FieldSidebar/FieldSidebar';
import { FieldsContext, useFieldDiscovery } from '../components/FieldsContext';
import { SavedSearchMenu } from '../components/SavedSearches/SavedSearchMenu';
import { PaginationBar } from '../components/PaginationBar';
import { DataViewPicker } from '../components/DataViewPicker/DataViewPicker';
import { AddToDashboardModal } from '../components/AddToDashboard/AddToDashboardModal';
import { canCreateDashboards } from '../utils/permissions';
import { runQueryRows } from '../data/runQuery';
import { buildLogsQuery, buildVolumeQuery, buildWhereConditions, resolveVolumeBreakdown, logRowKey, CORE_ALIAS } from '../sql/queryBuilder';
import { buildFieldIndex } from '../sql/fields';
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
const SIDEBAR_SPLIT_KEY = 'clickhouse-observe.logsExplorer.sidebarSplit';
const DEFAULT_SIDEBAR_SPLIT = 0.18;

function readSidebarSplit(): number {
  const raw = Number(window.localStorage.getItem(SIDEBAR_SPLIT_KEY));
  return raw > 0.05 && raw < 0.6 ? raw : DEFAULT_SIDEBAR_SPLIT;
}

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

  // Discovered once here (not just via <FieldsProvider> in descendants) so executeQuery below can
  // resolve JSON-path/Map-key field references to the right SQL — see useFieldDiscovery's doc
  // comment. fieldsState is also handed to <FieldsContext.Provider> further down so FieldSidebar/
  // SearchBar/etc. get the exact same discovery run rather than a second independent one.
  const fieldsState = useFieldDiscovery(config, timeRange);
  const fieldIndex = useMemo(() => buildFieldIndex(fieldsState.fields), [fieldsState.fields]);

  // Grafana's PageLayoutType.Custom chrome doesn't clamp to the viewport (see useAvailableHeight's
  // doc comment) — height:100% resolves against nothing, so without this the whole page scrolls
  // instead of just the log table. Same fix as TraceExplorer.tsx.
  const containerRef = useRef<HTMLDivElement>(null);
  const availableHeight = useAvailableHeight(containerRef);

  const [rows, setRows] = useState<LogRow[]>([]);
  const [volumeData, setVolumeData] = useState<VolumeDataPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<LogRow | null>(null);

  // Detail-drawer hydration: the grid query is narrowed (no SELECT *, see executeQuery below),
  // so the drawer's full row (Map attribute columns, "All fields", JSON) is fetched lazily per
  // page, keyed by logRowKey() rather than row offset/index — see buildLogsQuery's
  // BuildLogsQueryOpts doc comment for why offset-based matching isn't safe here.
  // State (not a ref) because detailRow below reads it during render — a ref's `.current` can
  // only be read in effects/handlers, not render.
  const [hydratedRows, setHydratedRows] = useState<Map<string, LogRow>>(new Map());
  // Pages whose full rows are already cached (success only — a failed fetch is retryable).
  const hydratedPagesRef = useRef<Set<number>>(new Set());
  // Pages with a hydrate fetch in flight, so re-opening the drawer on the same page while the
  // first fetch is still running doesn't fire a second identical query.
  const hydratingPagesRef = useRef<Set<number>>(new Set());
  const [detailLoading, setDetailLoading] = useState(false);

  // Histogram controls.
  // Breakdown initial value is set once at mount — no effect ever forces it back,
  // so user choices (including "No breakdown") always persist.
  const [intervalMode, setIntervalMode] = useState<IntervalMode>('auto');
  const [breakdown, setBreakdownState] = useState<BreakdownSel>(() =>
    caps.hasSeverity ? { kind: 'severity' } : { kind: 'none' }
  );
  // On a full page load, `config` starts out empty and hydrates async (see SourceConfigContext) —
  // so the useState initializer above often runs before caps.hasSeverity is true, defaulting to
  // 'none' even for a severity-capable view. This ref distinguishes that race from a real user
  // pick, so the one-time catch-up effect below never clobbers an explicit "No breakdown" choice.
  const breakdownUserSetRef = useRef(false);
  const setBreakdown = useCallback((sel: BreakdownSel) => {
    breakdownUserSetRef.current = true;
    setBreakdownState(sel);
  }, []);
  useEffect(() => {
    if (!breakdownUserSetRef.current && caps.hasSeverity && breakdown.kind === 'none') {
      setBreakdownState({ kind: 'severity' });
    }
  }, [caps.hasSeverity, breakdown.kind]);

  // Reset query state when the active data view changes so stale field refs don't carry over.
  const prevViewId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const viewId = activeView?.id;
    if (prevViewId.current !== undefined && prevViewId.current !== viewId) {
      dispatch({ type: 'LOAD_SAVED', state: DEFAULT_LOGS_QUERY_STATE });
      // Re-derive capabilities from the latest config (updates with activeView).
      const newCaps = viewCapabilities(config);
      breakdownUserSetRef.current = false;
      setBreakdownState(newCaps.hasSeverity ? { kind: 'severity' } : { kind: 'none' });
    }
    prevViewId.current = viewId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView?.id]);

  // Sidebar collapse + resizable width, persisted across sessions
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { containerProps: bodySplitterProps, primaryProps: sidebarPaneProps, secondaryProps: resultsPaneProps, splitterProps } =
    useSplitter({
      direction: 'row',
      initialSize: readSidebarSplit(),
      dragPosition: 'middle',
      onSizeChanged: (flexSize) => window.localStorage.setItem(SIDEBAR_SPLIT_KEY, String(flexSize)),
    });
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
    // A new list query invalidates any previously hydrated detail rows/pages — they were
    // fetched under the old filters/time range/sort and would otherwise mismatch the new rows.
    setHydratedRows(new Map());
    hydratedPagesRef.current = new Set();
    hydratingPagesRef.current = new Set();

    try {
      const stateWithCols: LogsQueryState = {
        ...queryState,
        columns: effectiveColumns,
      };
      // Fall back to the builder-generated query if rawSql is empty (e.g. raw mode was just
      // enabled and nothing has been explicitly run yet) — never send a blank query. Builder-mode
      // requests project only the grid's columns (no SELECT *) — the drawer lazily hydrates the
      // full row per page instead (see hydratePage below). Raw-SQL mode is untouched: whatever
      // the user wrote runs as-is, and the drawer reads straight off those rows, same as before.
      const sql = queryState.useRawSql
        ? queryState.rawSql || buildLogsQuery(config, stateWithCols, { limit: INITIAL_FETCH, offset: 0 }, undefined, fieldIndex)
        : buildLogsQuery(config, stateWithCols, { limit: INITIAL_FETCH, offset: 0 }, { projection: 'grid' }, fieldIndex);
      const resolved = resolveInterval(intervalMode, timeRange);
      const volSql = buildVolumeQuery(config, queryState, {
        interval: { unit: resolved.unit, value: resolved.value },
        breakdown: resolveVolumeBreakdown(breakdown, config),
      }, fieldIndex);

      const volPromise = caps.hasTime
        ? runQueryRows({ datasourceUid: config.datasourceUid, sql: volSql, timeRange, refId: 'vol' })
        : Promise.resolve<Array<ReturnType<typeof Object>>>([]);

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
      setVolumeData(caps.hasTime ? fillEmptyBuckets(volPoints, resolved, timeRange) : volPoints);
    } catch (err) {
      if (runRef.current === runId) {
        setError(String((err as Error)?.message ?? err));
      }
    } finally {
      if (runRef.current === runId) {
        setLoading(false);
      }
    }
  }, [config, queryState, timeRange, effectiveColumns, intervalMode, breakdown, caps.hasTime, fieldIndex]);

  // Fetches the full ('full' projection) rows for one grid page, so the detail drawer can show
  // Map attribute columns / "All fields" / JSON without the live list query paying SELECT *'s
  // cost for every row. Raw-SQL mode is exempt: those rows already carry whatever the user's own
  // query selected, so there's nothing to hydrate (see the `detailRow` memo below).
  const hydratePage = useCallback(
    async (pageIndex: number) => {
      if (
        queryState.useRawSql ||
        !config.datasourceUid ||
        hydratedPagesRef.current.has(pageIndex) ||
        hydratingPagesRef.current.has(pageIndex)
      ) {
        return;
      }
      hydratingPagesRef.current.add(pageIndex);
      const runId = runRef.current;
      setDetailLoading(true);
      try {
        const stateWithCols: LogsQueryState = {
          ...queryState,
          columns: effectiveColumns,
        };
        const sql = buildLogsQuery(
          config,
          stateWithCols,
          { limit: pageSize, offset: pageIndex * pageSize },
          { projection: 'full' },
          fieldIndex
        );
        const fullRows = await runQueryRows({
          datasourceUid: config.datasourceUid,
          sql,
          timeRange,
          refId: 'detail',
        });
        // Discard if a new list query (executeQuery) started while this was in flight — its
        // reset already cleared hydratedRows, so writing into it here would resurrect stale
        // data under the new query's key space.
        if (runRef.current !== runId) {
          return;
        }
        setHydratedRows((prev) => {
          const next = new Map(prev);
          for (const r of fullRows) {
            next.set(logRowKey(r), r);
          }
          return next;
        });
        hydratedPagesRef.current.add(pageIndex);
      } catch {
        // Leave the page unmarked as hydrated so the next drawer-open on this page retries,
        // rather than permanently degrading to summary-only after one transient failure.
      } finally {
        hydratingPagesRef.current.delete(pageIndex);
        if (runRef.current === runId) {
          setDetailLoading(false);
        }
      }
    },
    [config, queryState, effectiveColumns, timeRange, pageSize, fieldIndex]
  );

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
        conditions: buildWhereConditions(config, queryState, fieldIndex),
        timeRange,
        cacheKey: JSON.stringify([queryState.search, queryState.filters]),
      }),
    [config, queryState, timeRange, fieldIndex]
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
        // Load-more chunks are builder-mode only (raw-SQL is excluded above), so narrow the
        // same way the initial fetch in executeQuery does.
        const sql = buildLogsQuery(
          config,
          stateWithCols,
          { limit: chunkSize, offset: currentRows.length },
          { projection: 'grid' },
          fieldIndex
        );
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
    [config, queryState, timeRange, effectiveColumns, fieldIndex]
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
  // and as the seed value when switching into raw-SQL mode (see onToggleRawSql below). Uses the
  // same 'grid' projection as the live list query so this always reflects what's actually sent
  // to ClickHouse (raw mode, once entered, has no hydration — the user can add columns/`*` by
  // hand if they need the full row while hand-editing).
  const builderSql = buildLogsQuery(
    config,
    { ...queryState, columns: effectiveColumns },
    undefined,
    { projection: 'grid' },
    fieldIndex
  );

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

  // Ensure the current page's full rows are hydrated whenever the drawer is open (covers both
  // opening a row and paging prev/next across a page boundary while it's open).
  useEffect(() => {
    if (selectedRow) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      hydratePage(currentPage);
    }
  }, [selectedRow, currentPage, hydratePage]);

  // Looks up the lazily-hydrated full row by content key. Undefined here covers two cases the
  // drawer treats identically (falls back to the narrow `row` prop): "not hydrated yet" in
  // builder mode, and raw-SQL mode — hydratePage never populates hydratedRows there, since
  // `row` itself already carries whatever the user's own query selected (no narrowing happens
  // in raw mode). Deliberately NOT branching on queryState.useRawSql here: toggling that flag
  // alone (before running anything) doesn't change `rows`/selectedRow, so a lookup keyed only
  // on the row's content stays stable across the toggle — no flicker of previously-hydrated
  // attributes just from opening the raw-SQL editor.
  const detailRow = useMemo(() => {
    if (!selectedRow) {
      return undefined;
    }
    return hydratedRows.get(logRowKey(selectedRow));
  }, [selectedRow, hydratedRows]);

  return (
    <FieldsContext.Provider value={fieldsState}>
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
                height={44}
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
        <div
          {...(sidebarCollapsed ? {} : bodySplitterProps)}
          className={cx(styles.body, !sidebarCollapsed && bodySplitterProps.className)}
        >
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
            <>
              <div {...sidebarPaneProps} className={cx(sidebarPaneProps.className, styles.sidebarPane)}>
                <FieldSidebar
                  queryState={{ ...queryState, columns: effectiveColumns }}
                  timeRange={timeRange}
                  onToggleColumn={onToggleColumn}
                  onAddFilter={onAddFilter}
                  onCollapse={() => setSidebarCollapsed(true)}
                />
              </div>
              <div {...splitterProps} className={cx(splitterProps.className, styles.splitterHandle)} />
            </>
          )}

          <div {...(sidebarCollapsed ? {} : resultsPaneProps)} className={cx(sidebarCollapsed ? undefined : resultsPaneProps.className, styles.results)}>
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
            detailRow={detailRow}
            detailLoading={detailLoading}
            config={config}
            fields={fieldsState.fields}
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
    </FieldsContext.Provider>
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
    height: 44px;
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
    overflow: hidden;
  `,
  sidebarPane: css`
    min-width: 160px;
    overflow: hidden;
  `,
  splitterHandle: css`
    flex-shrink: 0;
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
    margin-right: ${theme.spacing(1.5)};
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
