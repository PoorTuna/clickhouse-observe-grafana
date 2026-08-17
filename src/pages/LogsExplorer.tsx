import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { css, cx } from '@emotion/css';
import { dateTime, GrafanaTheme2, PageLayoutType, rangeUtil, TimeRange } from '@grafana/data';
import { PluginPage } from '@grafana/runtime';
import { Button, Icon, Spinner, Switch, useStyles2, TimeRangePicker, RefreshPicker, useSplitter } from '@grafana/ui';
import { useSearchParams } from 'react-router-dom';
import { SearchBar } from '../components/SearchBar';
import { FilterPills } from '../components/FilterPills';
import { LogsTable } from '../components/LogsTable';
import { LogDetailDrawer } from '../components/LogDetailDrawer';
import { useTraceExploreLink } from '../components/useTraceExploreLink';
import { CompareLogsModal } from '../components/CompareLogsModal';
import { resolveInterval, ResolvedInterval, fillEmptyBuckets } from '../components/VolumeHistogram';
import { LogsHistogramPanel } from '../components/LogsHistogramPanel';
import { FieldSidebar, fieldToColumn } from '../components/FieldSidebar/FieldSidebar';
import { FieldsContext, useFieldDiscovery } from '../components/FieldsContext';
import { PaginationBar } from '../components/PaginationBar';
import { DataViewPicker } from '../components/DataViewPicker/DataViewPicker';
import { AddToDashboardModal } from '../components/AddToDashboard/AddToDashboardModal';
import { SqlInspectorBar } from '../components/SqlInspectorBar';
import { DiagnosticsDrawer } from '../components/Diagnostics/DiagnosticsDrawer';
import { canCreateDashboards } from '../utils/permissions';
import { runQueryRows } from '../data/runQuery';
import { startAction } from '../diag/tracer';
import { SpanHandle } from '../diag/types';
import { buildLogsQuery, buildLogDetailQuery, buildVolumeQuery, buildWhereConditions, resolveVolumeBreakdown, logRowKey, CORE_ALIAS } from '../sql/queryBuilder';
import { buildFieldIndex } from '../sql/fields';
import { loadFieldValues } from '../sql/kql/_values';
import { addFilterPill, makeFilter } from '../sql/filters';
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
import { decodeLogsState, encodeLogsState } from '../data/urlState';
import { errMsg } from '../errMsg';
import { shiftTimeRange, zoomOutTimeRange } from '../utils/timeRangeNav';
import { useAvailableHeight } from '../utils/useAvailableHeight';
import { logsQueryReducer } from './_logsQueryReducer';

const INITIAL_FETCH = 200;
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 250, 500];
const DEFAULT_PAGE_SIZE = 50;
const SIDEBAR_SPLIT_KEY = 'clickhouse-observe.logsExplorer.sidebarSplit';
const DEFAULT_SIDEBAR_SPLIT = 0.18;
const DETAIL_SPLIT_KEY = 'clickhouse-observe.logsExplorer.detailSplit';
const DEFAULT_DETAIL_SPLIT = 0.55;

function readSidebarSplit(): number {
  const raw = Number(window.localStorage.getItem(SIDEBAR_SPLIT_KEY));
  return raw > 0.05 && raw < 0.6 ? raw : DEFAULT_SIDEBAR_SPLIT;
}

function readDetailSplit(): number {
  const raw = Number(window.localStorage.getItem(DETAIL_SPLIT_KEY));
  return raw > 0.2 && raw < 0.8 ? raw : DEFAULT_DETAIL_SPLIT;
}

function defaultTimeRange(): TimeRange {
  return {
    from: dateTime(Date.now() - 3600 * 1000),
    to: dateTime(Date.now()),
    raw: { from: 'now-1h', to: 'now' },
  };
}

export function defaultColumns(config: SourceConfig): SelectedColumn[] {
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
  const core = cols
    .filter((col) => Boolean(col.sqlExpr))
    .map((col) => ({ ...col, isCore: true }));
  // "Pinned columns" — a per-view saved set of extra (non-core) columns appended after the fixed
  // core set (see SourceConfig.pinnedColumns). Core is never replaced or reordered by this; a
  // pinned entry that happens to duplicate a mapped core column's sqlExpr (e.g. someone pinned
  // ServiceName by hand) is dropped so it doesn't render twice.
  const coreExprs = new Set(core.map((col) => col.sqlExpr));
  const pinned = (config.pinnedColumns ?? []).filter((col) => !coreExprs.has(col.sqlExpr));
  return [...core, ...pinned];
}

export function LogsExplorer() {
  const styles = useStyles2(getStyles);
  const config = useContext(SourceConfigContext);
  const { activeView, setActiveViewId } = useContext(DataViewContext);
  const caps = viewCapabilities(config);

  const [searchParams, setSearchParams] = useSearchParams();
  // Decoded exactly once, at mount — a lazy useState initializer ignores any later change to
  // `searchParams`'s identity, which matters because the serialize-to-URL effect below rewrites
  // `searchParams` on every state change; re-decoding on every one of those writes would just be
  // reading back what was just written (harmless but pointless), and reacting to a *user* editing
  // the URL bar directly isn't a goal here — this state has no canonical non-URL source of truth
  // to resync from.
  const [initialUrlState] = useState(() => decodeLogsState(searchParams));

  const [queryState, dispatch] = useReducer(
    logsQueryReducer,
    DEFAULT_LOGS_QUERY_STATE,
    (init) => {
      const baseFilters = initialUrlState.filters ?? init.filters;
      // Inbound trace->logs link (?traceId=…, see data/traceToLogsLink.ts): seed a filter pill for
      // it, appended after the URL's own `filters` so both survive. Only when this view actually
      // has a trace column mapped — config is available here because App.tsx already resolved the
      // right Data View (possibly via the trace picker modal) before LogsExplorer ever mounted.
      const filters =
        initialUrlState.traceId && config.columns.traceId
          ? addFilterPill(baseFilters, makeFilter(config.columns.traceId, initialUrlState.traceId, '='))
          : baseFilters;
      return {
        ...init,
        ...(initialUrlState.search !== undefined ? { search: initialUrlState.search } : {}),
        ...(initialUrlState.filters || filters !== baseFilters ? { filters } : {}),
        ...(initialUrlState.columns ? { columns: initialUrlState.columns } : {}),
        ...(initialUrlState.sort ? { sort: initialUrlState.sort } : {}),
      };
    }
  );
  const [timeRange, setTimeRange] = useState<TimeRange>(() => initialUrlState.timeRange ?? defaultTimeRange());
  const getTraceHref = useTraceExploreLink(config.datasourceUid, timeRange);

  // Discovered once here (not just via <FieldsProvider> in descendants) so executeQuery below can
  // resolve JSON-path/Map-key field references to the right SQL — see useFieldDiscovery's doc
  // comment. fieldsState is also handed to <FieldsContext.Provider> further down so FieldSidebar/
  // SearchBar/etc. get the exact same discovery run rather than a second independent one.
  const fieldsState = useFieldDiscovery(config, timeRange);
  // Phase-A-only (see FieldsContext.tsx) — this index only needs to resolve a bare name typed
  // into KQL/filter shorthand to a real config-column/discovered-column sqlExpr; a sidebar- or
  // drawer-originated filter/column already carries its resolved sqlExpr directly (FieldModel.
  // sqlExpr), never a bare name needing lookup. Keeping this stable across hydration also avoids
  // recreating hydratePage/hydrateRow/ensureRows (all keyed off it) every time a page finishes
  // hydrating.
  const fieldIndex = useMemo(() => buildFieldIndex(fieldsState.fields), [fieldsState.fields]);
  // Mount-query queries (fetchLogs/fetchVolume) read the field index through this ref instead of
  // closing over `fieldIndex` directly — see the comment on their useCallback deps below for why:
  // depending on `fieldIndex` there made both queries re-fire the moment async field discovery
  // completed (identity change → callback recreated → the effects that call them re-run), doubling
  // every cold-mount query and chaining the second run behind however long discovery took (~15s on
  // a large dataset). Kept in sync every render so callers always read the latest value.
  const fieldIndexRef = useRef(fieldIndex);
  useEffect(() => {
    fieldIndexRef.current = fieldIndex;
  }, [fieldIndex]);

  // Grafana's PageLayoutType.Custom chrome doesn't clamp to the viewport (see useAvailableHeight's
  // doc comment) — height:100% resolves against nothing, so without this the whole page scrolls
  // instead of just the log table.
  const containerRef = useRef<HTMLDivElement>(null);
  const availableHeight = useAvailableHeight(containerRef);

  const [rows, setRows] = useState<LogRow[]>([]);
  const [volumeData, setVolumeData] = useState<VolumeDataPoint[]>([]);
  const [loading, setLoading] = useState(false);
  // Separate from `loading` (which tracks the logs/grid query only) so a column add/remove —
  // which never touches the volume query, see fetchVolume's narrower deps below — doesn't make
  // the histogram appear to reload, and so the histogram can show its own stale-data overlay
  // instead of silently keeping old bars during an actual volume refetch.
  const [volLoading, setVolLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<LogRow | null>(null);
  // Mirrors selectedRow for fetchLogs's hydratedRows-pruning below — read from a callback whose
  // deps deliberately don't include selectedRow (see fetchLogs), same pattern as hydratedRowsRef.
  const selectedRowRef = useRef(selectedRow);
  useEffect(() => {
    selectedRowRef.current = selectedRow;
  }, [selectedRow]);
  // "Expand" on the log detail pane — visually overrides the splitter's flex-basis
  // without touching its underlying drag state, so collapsing back returns to whatever width the
  // user last dragged it to. Reset whenever the drawer closes so the next log opens at normal size.
  const [detailExpanded, setDetailExpanded] = useState(false);

  // Detail-drawer hydration: the grid query is narrowed (no SELECT *, see executeQuery below),
  // so the drawer's full row (Map attribute columns, "All fields", JSON) is fetched lazily per
  // page, keyed by logRowKey() rather than row offset/index — see buildLogsQuery's
  // BuildLogsQueryOpts doc comment for why offset-based matching isn't safe here.
  // State (not a ref) because detailRow below reads it during render — a ref's `.current` can
  // only be read in effects/handlers, not render.
  const [hydratedRows, setHydratedRows] = useState<Map<string, LogRow>>(new Map());
  // Mirrors hydratedRows for hydrateRow's "already fetched" check below — read from a callback,
  // not render, so it can't be a useCallback dep (that would recreate hydrateRow, and therefore
  // retrigger the effect that calls it, on every unrelated hydration commit).
  const hydratedRowsRef = useRef(hydratedRows);
  useEffect(() => {
    hydratedRowsRef.current = hydratedRows;
  }, [hydratedRows]);

  // Pages whose full rows are already cached (success only — a failed fetch is retryable).
  const hydratedPagesRef = useRef<Set<number>>(new Set());
  // Pages with a hydrate fetch in flight, so re-opening the drawer on the same page while the
  // first fetch is still running doesn't fire a second identical query.
  const hydratingPagesRef = useRef<Set<number>>(new Set());
  // Row keys with a single-row hydrate fetch in flight — same guard as hydratingPagesRef, for
  // hydrateRow below.
  const hydratingRowKeysRef = useRef<Set<string>>(new Set());
  const [detailLoading, setDetailLoading] = useState(false);
  // Set when hydrateRow's point lookup AND its hydratePage fallback both fail to produce the
  // selected row — surfaced by the drawer as a blocking error + Retry, never silently degraded
  // to the narrow grid columns (see LogDetailDrawer's fieldsError/detailError props).
  const [detailError, setDetailError] = useState<string | null>(null);

  // Histogram controls.
  // Breakdown: `breakdownChoice` is null until the user explicitly picks something — the
  // *effective* value (`breakdown`, derived below) falls back to severity/none based on the
  // view's current capabilities. Deriving it instead of computing a default once at mount and
  // trying to "catch up" via an effect sidesteps a real race: on a full page load `config` starts
  // out empty and hydrates async (see SourceConfigContext), so caps.hasSeverity often isn't true
  // yet on the render that would have set the initial value. A derived value can't go stale like
  // that — whatever caps.hasSeverity is *right now* is what an unset choice resolves to.
  const [intervalMode, setIntervalMode] = useState<IntervalMode>('auto');
  const [breakdownChoice, setBreakdown] = useState<BreakdownSel | null>(null);
  // Memoized: when breakdownChoice is null this falls back to a freshly-built object literal —
  // without useMemo that's a new reference every render, which churns executeQuery's identity
  // (it depends on breakdown) and retriggers the effect that calls it, in an infinite fetch loop.
  const breakdown: BreakdownSel = useMemo(
    () => breakdownChoice ?? (caps.hasSeverity ? { kind: 'severity' } : { kind: 'none' }),
    [breakdownChoice, caps.hasSeverity]
  );

  // Reset query state when the active data view changes so stale field refs don't carry over.
  const prevViewId = useRef<string | undefined>(undefined);
  // Guards the one-shot post-discovery reconcile fetch (declared with fetchLogs/fetchVolume
  // below) — reset on view change too, since a new view means a new table and a fresh discovery
  // cycle to reconcile against.
  const didReconcileForDiscoveryRef = useRef(false);

  // One-shot: a shared URL (`?ds=...`) selects a data view other than whatever App.tsx picked as
  // the default. Applying it here — instead of expecting the link recipient to pick it manually —
  // is what makes items like column/filter restoration below actually line up with the right
  // table. Pre-seeds `prevViewId` to the URL's target *before* calling setActiveViewId, so the
  // reset effect right below (which fires when activeView.id changes) sees a no-op transition
  // instead of treating this URL-driven switch as a user action and wiping the query state that
  // was just hydrated from that same URL (see initialUrlState above).
  const appliedUrlViewRef = useRef(false);
  useEffect(() => {
    if (appliedUrlViewRef.current) {
      return;
    }
    appliedUrlViewRef.current = true;
    if (initialUrlState.viewId && initialUrlState.viewId !== activeView?.id) {
      prevViewId.current = initialUrlState.viewId;
      setActiveViewId(initialUrlState.viewId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const viewId = activeView?.id;
    if (prevViewId.current !== undefined && prevViewId.current !== viewId) {
      dispatch({ type: 'LOAD_SAVED', state: DEFAULT_LOGS_QUERY_STATE });
      setBreakdown(null);
      didReconcileForDiscoveryRef.current = false;
    }
    prevViewId.current = viewId;
     
  }, [activeView?.id]);

  // Sidebar collapse + resizable width, persisted across sessions
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Auto-minimize the fields sidebar while the log detail drawer is open — it's competing for the
  // same horizontal space the drawer needs. Restores on close, but only if the user hadn't already
  // collapsed it manually before opening (so a manual collapse isn't clobbered by the drawer closing).
  const wasOpenRef = useRef(false);
  const collapsedBeforeOpenRef = useRef(false);
  useEffect(() => {
    const isOpen = selectedRow !== null;
    if (isOpen && !wasOpenRef.current) {
      setSidebarCollapsed((prev) => {
        collapsedBeforeOpenRef.current = prev;
        return true;
      });
    } else if (!isOpen && wasOpenRef.current && !collapsedBeforeOpenRef.current) {
      setSidebarCollapsed(false);
    }
    wasOpenRef.current = isOpen;
  }, [selectedRow]);
  const { containerProps: bodySplitterProps, primaryProps: sidebarPaneProps, secondaryProps: resultsPaneProps, splitterProps } =
    useSplitter({
      direction: 'row',
      initialSize: readSidebarSplit(),
      dragPosition: 'middle',
      onSizeChanged: (flexSize) => window.localStorage.setItem(SIDEBAR_SPLIT_KEY, String(flexSize)),
    });
  // Table | inline log detail split (replaces the old overlay Drawer) — same persistence pattern.
  const {
    containerProps: detailSplitterProps,
    primaryProps: tablePaneProps,
    secondaryProps: detailPaneProps,
    splitterProps: detailHandleProps,
  } = useSplitter({
    direction: 'row',
    initialSize: readDetailSplit(),
    dragPosition: 'middle',
    onSizeChanged: (flexSize) => window.localStorage.setItem(DETAIL_SPLIT_KEY, String(flexSize)),
  });
  const [showSqlInspect, setShowSqlInspect] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
  const [histogramCollapsed, setHistogramCollapsed] = useState(false);
  // Multi-select for the "Compare" action — indices into `pageRows`. Cleared whenever the page
  // of rows changes (new query, sort, or pagination) since indices from a prior page are
  // meaningless against a new one.
  const [compareSelection, setCompareSelection] = useState<Set<number>>(new Set());
  const [compareOpen, setCompareOpen] = useState(false);
  const onToggleCompare = (i: number) => {
    setCompareSelection((prev) => {
      const next = new Set(prev);
      if (next.has(i)) {
        next.delete(i);
      } else {
        next.add(i);
      }
      return next;
    });
  };
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
  // Separate cancellation token for the volume query, which now runs on its own effect/deps
  // (see fetchVolume) independent of the logs query's runRef.
  const volRunRef = useRef(0);
  // AbortControllers paired 1:1 with each runRef/volRunRef generation. Aborting the previous
  // controller when a new run starts does NOT stop ClickHouse from executing the abandoned query
  // (see RunQueryOptions.signal's doc comment in data/runQuery.ts) — it only stops this tab from
  // waiting on and decoding a response nobody will use. hydratePage/hydrateRow/ensureRows piggyback
  // on the logs run's controller since they share runRef's generation.
  const runAbortRef = useRef<AbortController | null>(null);
  const volAbortRef = useRef<AbortController | null>(null);
  // The diagnostics action fetchLogs/fetchVolume should attach their query spans under, if any.
  // Set synchronously immediately before a paired fetchLogs()+fetchVolume() call (see executeQuery
  // below) and cleared synchronously right after — safe because both functions read it at the very
  // top of their body, before their own first `await`, so there's no async gap for another action
  // to interleave and steal the wrong attribution. The independently-debounced single-fetch effects
  // further down deliberately leave this unset: fetchLogs and fetchVolume re-fire on different
  // triggers there (see their effects' own comments), so they're genuinely separate top-level
  // activity entries, not one action's children — runQuery.ts's orphan-root fallback already names
  // each correctly by its `op` when no trace is passed.
  const actionRef = useRef<SpanHandle | null>(null);
  // A 'render' child span, opened right before setRows(logRows) and closed by the useLayoutEffect
  // below once the resulting DOM commit has actually painted — see that effect for why two RAF-ish
  // steps are needed instead of just one. Answers this whole feature's founding question for the
  // render-side case: "was it ClickHouse, or was it us?" (see the diagnostics plan's Context
  // section) — without it, render time was invisible even though every query's time was not.
  const pendingRenderSpanRef = useRef<SpanHandle | null>(null);
  // Always tracks the latest executeQuery closure so deferred calls get fresh state.
  const latestExecuteQuery = useRef<(actionName?: string) => void>(() => {});
  // Groups the two independently-debounced fetchLogs/fetchVolume effects below (the ones the
  // comment above actionRef says are "genuinely separate top-level activity entries") back under
  // one shared action when they're actually responding to the same user change — a time-range
  // drag, a filter add, a search submit. Ungrouped, one search bar keystroke could produce two
  // unrelated-looking rail entries ('logs' and 'volume') instead of one named action containing
  // both, which is exactly the "reads as soup" rail problem this fixes. Sidebar discovery
  // (columns at mount; mapKeys/jsonPaths on-demand per Map/JSON column click) genuinely has no
  // shared gesture with a logs/volume fetch and stays ungrouped orphan roots, per the original
  // design.
  const groupActionRef = useRef<{ action: SpanHandle; promises: Array<Promise<unknown>> } | null>(null);
  const groupSettleTimerRef = useRef<number | null>(null);

  // A small grace window after a fetch joins the shared group action, giving the OTHER debounced
  // effect (logs vs. volume) a chance to also join before the group is finalized — both effects use
  // the same MUTATION_DEBOUNCE_MS below and fire from the same originating state change, so in
  // practice they land within a tick of each other. Restarted on every join, so if both fetches
  // join back-to-back the group only finalizes once, after the last one settles.
  const GROUP_SETTLE_GRACE_MS = 50;

  // Effective columns: use state if set, else derive defaults from config
  const effectiveColumns = useMemo<SelectedColumn[]>(() => {
    return queryState.columns.length > 0 ? queryState.columns : defaultColumns(config);
  }, [queryState.columns, config]);

  // What describeGroupChange's diff last compared against — updated only when a NEW group action
  // is created (see joinGroupAction above), not on every render, so the diff reflects "what
  // changed since the last named action" rather than "what changed since the last render". Starts
  // null (rather than seeding from current state) deliberately: reading effectiveColumns/queryState
  // directly in a useRef initializer defeated the React Compiler's ability to preserve
  // effectiveColumns' own memoization. describeGroupChange treats a null previous snapshot as "the
  // first group ever" and names it 'Load' rather than diffing against a guess.
  const lastGroupSnapshotRef = useRef<{
    search: string;
    filtersKey: string;
    columnsKey: string;
    sortKey: string;
    timeRangeKey: string;
  } | null>(null);

  /** Names a newly-created group action from whichever tracked field actually changed since the
   *  last one was named — checked in roughly causal-salience order (a time-range drag is a bigger
   *  "why did this run" story than a column reorder). Falls back to 'Load' for the mount-time case,
   *  where there's nothing to diff against yet. */
  function describeGroupChange(): string {
    const prev = lastGroupSnapshotRef.current;
    const curr = {
      search: queryState.search,
      filtersKey: JSON.stringify(queryState.filters),
      columnsKey: JSON.stringify(effectiveColumns),
      sortKey: JSON.stringify(queryState.sort),
      timeRangeKey: `${timeRange.from.valueOf()}-${timeRange.to.valueOf()}`,
    };
    lastGroupSnapshotRef.current = curr;
    if (!prev) {
      return 'Load';
    }
    if (curr.timeRangeKey !== prev.timeRangeKey) {
      return 'Time range';
    }
    if (curr.filtersKey !== prev.filtersKey) {
      return 'Filters';
    }
    if (curr.search !== prev.search) {
      return 'Search';
    }
    if (curr.sortKey !== prev.sortKey) {
      return 'Sort';
    }
    if (curr.columnsKey !== prev.columnsKey) {
      return 'Columns';
    }
    return 'Load';
  }

  /** Returns the current group action, creating one (named from whatever changed) if none is
   *  already pending. Callers must set `actionRef.current` to the returned handle immediately
   *  before invoking fetchLogs()/fetchVolume() and clear it right after — same synchronous-window
   *  requirement as executeQuery's own use of actionRef (see its declaration above). */
  function joinGroupAction(): SpanHandle {
    if (groupActionRef.current) {
      return groupActionRef.current.action;
    }
    const action = startAction(describeGroupChange());
    groupActionRef.current = { action, promises: [] };
    return action;
  }

  /** Registers `promise` (the fetchLogs()/fetchVolume() call just made under the current group
   *  action) and (re)schedules the group's finalization after GROUP_SETTLE_GRACE_MS — see that
   *  constant's doc comment for why a grace window, not an immediate close, is what lets both
   *  fetches land under one action instead of racing to close it after just the first. */
  function trackGroupPromise(promise: Promise<unknown>): void {
    const group = groupActionRef.current;
    if (!group) {
      return;
    }
    group.promises.push(promise);
    if (groupSettleTimerRef.current != null) {
      window.clearTimeout(groupSettleTimerRef.current);
    }
    groupSettleTimerRef.current = window.setTimeout(() => {
      groupSettleTimerRef.current = null;
      if (groupActionRef.current !== group) {
        return;
      }
      groupActionRef.current = null;
      Promise.allSettled(group.promises).then(() => {
        const hasError = group.action.span.children.some((child) => child.status === 'error');
        group.action.end(hasError ? 'error' : 'ok');
      });
    }, GROUP_SETTLE_GRACE_MS);
  }

  // Keeps the URL in sync with the current shareable state, so the address bar is always a valid
  // "copy this link" snapshot (users copy it straight from the browser's address bar) — same field
  // set as Saved Searches (search/filters/columns/sort/timeRange), plus the active view. `replace:
  // true` so typing in the search box or dragging the time picker doesn't spam browser history
  // with one entry per keystroke.
  // On mount, this can fire once before the "apply URL view" effect above's setActiveViewId has
  // committed, briefly writing the pre-switch view/state — harmless (replace: true, and this
  // effect's own activeView?.id dependency makes it re-fire and correct itself once that lands).
  useEffect(() => {
    const next = encodeLogsState({
      search: queryState.search,
      filters: queryState.filters,
      // Only encode columns when the user actually customized them (queryState.columns is
      // non-empty) — effectiveColumns itself is NEVER empty (it falls back to defaultColumns()
      // below), so passing it through unconditionally would bake the view's full default column
      // set into every link even when nothing was touched. That was the bulk of a shared link's
      // length in practice: every default-layout link carried 4+ full column objects for no
      // reason. queryState.columns.length === 0 already means "use view defaults" everywhere else
      // in this file — encodeLogsState's own `columns.length > 0` guard (urlState.ts) then omits
      // the param entirely, and decodeLogsState leaves it unset on the receiving end, which
      // correctly falls back to that view's own defaultColumns() too.
      columns: queryState.columns.length > 0 ? effectiveColumns : [],
      sort: queryState.sort,
      timeRange,
      viewId: activeView?.id,
    });
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryState.search, queryState.filters, queryState.sort, queryState.columns, effectiveColumns, timeRange, activeView?.id]);

  const resolvedInterval = useMemo<ResolvedInterval>(
    () => resolveInterval(intervalMode, timeRange),
    [intervalMode, timeRange]
  );

  const totalEvents = useMemo(
    () => volumeData.reduce((sum, d) => sum + Object.values(d.levels).reduce((a, b) => a + b, 0), 0),
    [volumeData]
  );

  // Logs/grid query only. Deps intentionally include effectiveColumns (a column add/remove does
  // need to re-run this — the grid projection's SELECT list is exactly the displayed columns) but
  // NOT the volume-only inputs (intervalMode/breakdown) — see fetchVolume below for why those are
  // split out instead of living in one combined fetch.
  const fetchLogs = useCallback(async () => {
    if (!config.datasourceUid) {
      setError('No ClickHouse datasource configured. Go to Configuration to set it up.');
      return;
    }
    const runId = ++runRef.current;
    runAbortRef.current?.abort();
    const abortController = new AbortController();
    runAbortRef.current = abortController;
    // Snapshot now (still synchronous, before this function's first await) rather than reading
    // actionRef.current again down at the runQueryRows call — see actionRef's declaration for why
    // that matters.
    const action = actionRef.current ?? undefined;
    setLoading(true);
    setError(null);
    // A new list query invalidates any previously hydrated detail rows/pages — they were
    // fetched under the old filters/time range/sort and would otherwise mismatch the new rows.
    // Exception: the currently-open drawer's row. With the drawer now blocking on hydration
    // (see LogDetailDrawer), clearing it unconditionally meant every auto-refresh (every 30s by
    // default) flashed the drawer back to a full-body loading spinner even though the same row
    // (by content key) is almost always still hydrated and still present in the new results —
    // setSelectedRow below re-points at it by the same key. Keep just that one entry; everything
    // else is dropped as before.
    setHydratedRows((prev) => {
      const key = selectedRowRef.current ? logRowKey(selectedRowRef.current, config) : null;
      const surviving = key ? prev.get(key) : undefined;
      return surviving ? new Map([[key as string, surviving]]) : new Map();
    });
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
        ? queryState.rawSql || buildLogsQuery(config, stateWithCols, { limit: INITIAL_FETCH, offset: 0 }, undefined, fieldIndexRef.current)
        : buildLogsQuery(config, stateWithCols, { limit: INITIAL_FETCH, offset: 0 }, { projection: 'grid' }, fieldIndexRef.current);

      const logRows = await runQueryRows({
        datasourceUid: config.datasourceUid,
        sql,
        timeRange,
        refId: 'logs',
        signal: abortController.signal,
        op: 'logs',
        trace: action,
      });

      if (runRef.current !== runId) {
        return;
      }

      // Opened here (immediately before the commit it's measuring) rather than nearer the top of
      // fetchLogs, since the query time above is already covered by its own span — this one starts
      // exactly where "we have the data, now we have to paint it" begins.
      pendingRenderSpanRef.current = action?.child('render', 'render') ?? null;
      setRows(logRows);
      setCurrentPage(0);
      setHasMore(!queryState.useRawSql && logRows.length === INITIAL_FETCH);
      // Any query re-run (auto-refresh, filter/search/time-range change) replaces `rows` with
      // fresh row objects — the open detail panel's `selectedRow` would otherwise keep pointing
      // at a now-detached old object, invisible in the new array, collapsing the panel down to
      // just the narrow grid columns it was opened with (hydratedRows was just cleared above too).
      // Re-point it at the matching row in the new results by content key, or close the panel if
      // that row is gone (e.g. it no longer matches the filters).
      setSelectedRow((prev) => {
        if (!prev) {
          return prev;
        }
        const key = logRowKey(prev, config);
        return logRows.find((r) => logRowKey(r, config) === key) ?? null;
      });
    } catch (err) {
      if (runRef.current === runId) {
        setError(errMsg(err));
      }
    } finally {
      if (runRef.current === runId) {
        setLoading(false);
      }
    }
    // fieldIndex intentionally excluded — read via fieldIndexRef instead (see its declaration
    // above): this query must run once immediately on mount, not wait for async field discovery.
  }, [config, queryState, timeRange, effectiveColumns]);

  // Volume/histogram query only. Deps deliberately narrower than fetchLogs: buildVolumeQuery
  // never reads state.columns, state.sort, or raw-SQL mode (see queryBuilder.ts), so a column
  // add/remove/reorder or a sort click must NOT re-run this — it used to, because both queries
  // lived in one callback that closed over the whole queryState/effectiveColumns.
  const fetchVolume = useCallback(async () => {
    if (!config.datasourceUid || !caps.hasTime) {
      setVolumeData([]);
      return;
    }
    const runId = ++volRunRef.current;
    volAbortRef.current?.abort();
    const abortController = new AbortController();
    volAbortRef.current = abortController;
    // See the matching comment in fetchLogs above.
    const action = actionRef.current ?? undefined;
    setVolLoading(true);
    try {
      const resolved = resolveInterval(intervalMode, timeRange);
      const volSql = buildVolumeQuery(config, queryState, {
        interval: { unit: resolved.unit, value: resolved.value },
        breakdown: resolveVolumeBreakdown(breakdown, config),
      }, fieldIndexRef.current);

      const volRows = await runQueryRows({
        datasourceUid: config.datasourceUid,
        sql: volSql,
        timeRange,
        refId: 'vol',
        signal: abortController.signal,
        op: 'volume',
        trace: action,
      });

      if (volRunRef.current !== runId) {
        return;
      }

      const volMap = new Map<number, Record<string, number>>();
      for (const r of volRows) {
        const t = typeof r['time'] === 'number' ? r['time'] : Number(r['time'] ?? 0);
        const level = String(r['level'] ?? 'unknown');
        const count = Number(r['count'] ?? 0);
        if (!volMap.has(t)) {
          volMap.set(t, {});
        }
        volMap.get(t)![level] = (volMap.get(t)![level] ?? 0) + count;
      }
      const volPoints: VolumeDataPoint[] = Array.from(volMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([time, levels]) => ({ time, levels }));
      setVolumeData(fillEmptyBuckets(volPoints, resolved, timeRange));
    } catch (err) {
      if (volRunRef.current === runId) {
        // Also clear volumeData: a failed refetch must not leave the previous time range's bars
        // on screen under a new range/filter — that reads as a (wrong) real answer, not an error.
        setVolumeData([]);
        const rawMsg = errMsg(err);
        // ClickHouse's timeout_overflow_mode = 'throw' (see VOLUME_QUERY_SETTINGS) surfaces as
        // this substring — reword it into something the user can act on instead of a raw
        // ClickHouse error string.
        setError(
          /timeout exceeded|TIMEOUT_EXCEEDED/i.test(rawMsg)
            ? 'Histogram query exceeded its 60s budget — narrow the time range or choose a coarser interval.'
            : rawMsg
        );
      }
    } finally {
      if (volRunRef.current === runId) {
        setVolLoading(false);
      }
    }
    // Deliberately narrowed: buildVolumeQuery reads the whole `queryState` object but only ever
    // uses .search/.filters (via buildWhereConditions) — never .columns/.sort/.rawSql/.useRawSql
    // (see queryBuilder.ts). Depending on the full object would re-run this on every column/sort
    // mutation, exactly the redundant volume re-query this split was meant to eliminate.
    // fieldIndex is also excluded — read via fieldIndexRef (see its declaration above) so this
    // doesn't re-fire the moment field discovery completes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, queryState.search, queryState.filters, timeRange, intervalMode, breakdown, caps.hasTime]);

  // Combined re-run for call sites that mean "run the whole thing again" (manual refresh button,
  // auto-refresh interval, loading a saved search) — as opposed to the narrower per-effect fetches
  // below that only fire the query actually affected by what changed. `actionName` distinguishes
  // those three triggers in the diagnostics drawer's activity list — see each call site below.
  // actionRef is set synchronously right before, and cleared synchronously right after, the two
  // fetch calls it wraps — see actionRef's declaration for why that ordering is what makes it safe.
  const executeQuery = useCallback(
    (actionName?: string) => {
      // Defensive, not just stylistic: RefreshPicker's onRefresh is typed () => void, but at
      // least one real build called it as a click handler and passed the SyntheticEvent through —
      // a default parameter alone doesn't catch that (defaults only apply to `undefined`, and an
      // event object is truthy), so `startAction` received the event as `name` and React error #31
      // fired the moment the rail tried to render it as text. Every caller now passes an explicit
      // literal (see each call site), but this guard means a future caller forgetting to can never
      // put a non-string back into the span tree.
      const name = typeof actionName === 'string' && actionName ? actionName : 'Refresh';
      const action = startAction(name);
      actionRef.current = action;
      const logsPromise = fetchLogs();
      const volumePromise = fetchVolume();
      actionRef.current = null;
      // fetchLogs/fetchVolume catch their own errors internally (they setError, not throw), so
      // this never rejects — it only exists to know when both have settled so the action root can
      // leave 'running'. Its own status reflects whether either child query ended in error, since
      // nothing else would ever close this span otherwise (see actionRef's declaration).
      Promise.allSettled([logsPromise, volumePromise]).then(() => {
        const hasError = action.span.children.some((child) => child.status === 'error');
        action.end(hasError ? 'error' : 'ok');
      });
    },
    [fetchLogs, fetchVolume]
  );

  // One-shot reconcile: fetchLogs/fetchVolume no longer depend on fieldIndex (see fieldIndexRef
  // above), so a cold mount runs each exactly once instead of waiting on/re-running after field
  // discovery. That's correct for the common case (no filters yet), but a search/filter already
  // active at mount (e.g. restored from a shared URL or a saved search) may reference a Map key
  // or JSON path that hadn't been discovered when that first query built its WHERE clause. Once
  // discovery finishes, re-run — but only once, and only if there's something to reconcile —
  // rather than on every fields update, or this reintroduces the doubling this change removes.
  useEffect(() => {
    if (fieldsState.loading || didReconcileForDiscoveryRef.current) {
      return;
    }
    didReconcileForDiscoveryRef.current = true;
    if (queryState.filters.length > 0 || queryState.search.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchLogs();
      fetchVolume();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldsState.loading]);

  // Fetches the full ('full' projection) rows for one grid page, so the detail drawer can show
  // Map attribute columns / "All fields" / JSON without the live list query paying SELECT *'s
  // cost for every row. Raw-SQL mode is exempt: those rows already carry whatever the user's own
  // query selected, so there's nothing to hydrate (see the `detailRow` memo below).
  // Returns whether `targetKey` (if given) ended up in hydratedRows after this page fetch — lets
  // hydrateRow's fallback below tell "fetched the page, but the row genuinely isn't in it" apart
  // from "fetched fine" without racing hydratedRowsRef's post-commit sync.
  const hydratePage = useCallback(
    async (pageIndex: number, targetKey?: string): Promise<boolean> => {
      if (queryState.useRawSql || !config.datasourceUid) {
        return false;
      }
      if (hydratedPagesRef.current.has(pageIndex) || hydratingPagesRef.current.has(pageIndex)) {
        return targetKey ? hydratedRowsRef.current.has(targetKey) : true;
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
          signal: runAbortRef.current?.signal,
          op: 'detailPage',
        });
        // Discard if a new list query (executeQuery) started while this was in flight — its
        // reset already cleared hydratedRows, so writing into it here would resurrect stale
        // data under the new query's key space.
        if (runRef.current !== runId) {
          return false;
        }
        setHydratedRows((prev) => {
          const next = new Map(prev);
          for (const r of fullRows) {
            next.set(logRowKey(r, config), r);
          }
          return next;
        });
        hydratedPagesRef.current.add(pageIndex);
        return targetKey ? fullRows.some((r) => logRowKey(r, config) === targetKey) : true;
      } catch (e) {
        // Leave the page unmarked as hydrated so the next drawer-open on this page retries,
        // rather than permanently degrading to summary-only after one transient failure. Gated on
        // runId, same as every other setError in this file — otherwise a page fetch that a newer
        // search superseded (and which now rejects as an AbortError, see runAbortRef above) would
        // flash a phantom error for a request nobody cares about anymore.
        if (runRef.current === runId) {
          setDetailError(errMsg(e));
        }
        return false;
      } finally {
        hydratingPagesRef.current.delete(pageIndex);
        if (runRef.current === runId) {
          setDetailLoading(false);
        }
      }
    },
    [config, queryState, effectiveColumns, timeRange, pageSize, fieldIndex]
  );

  // Fetches just the single row the detail drawer is open for (see buildLogDetailQuery's doc
  // comment) — replaces hydratePage as the drawer-open fetch. hydratePage stays in use for the
  // "Compare" action (genuinely needs several arbitrary rows) and as this function's own
  // fallback when the point lookup can't find/build a match.
  const hydrateRow = useCallback(
    async (targetRow: LogRow) => {
      if (queryState.useRawSql || !config.datasourceUid) {
        return;
      }
      const key = logRowKey(targetRow, config);
      if (hydratedRowsRef.current.has(key) || hydratingRowKeysRef.current.has(key)) {
        return;
      }
      hydratingRowKeysRef.current.add(key);
      const runId = runRef.current;
      setDetailLoading(true);
      setDetailError(null);
      try {
        const sql = buildLogDetailQuery(config, targetRow, fieldIndexRef.current);
        if (!sql) {
          // No timestamp mapped, or the row's timestamp couldn't be parsed — fall back to the
          // whole-page fetch rather than leaving the drawer permanently unhydrated.
          const found = await hydratePage(currentPage, key);
          if (runRef.current === runId && !found) {
            setDetailError(
              "Couldn't load this row's full data — no timestamp column is mapped for this view, " +
              'and the row was not present in the current page fetch.'
            );
          }
          return;
        }
        const fullRows = await runQueryRows({
          datasourceUid: config.datasourceUid,
          sql,
          timeRange,
          refId: 'detail-row',
          signal: runAbortRef.current?.signal,
          op: 'detailRow',
        });
        if (runRef.current !== runId) {
          return;
        }
        if (fullRows.length === 0) {
          // Point lookup missed (millisecond-window/core-field mismatch, or the row aged out of
          // the mapped range between list-fetch and click) — fall back so the drawer isn't stuck
          // showing only the narrow grid columns. If the fallback also can't find it, this is the
          // multi-replica read-inconsistency case the sequential-consistency setting exists for.
          const found = await hydratePage(currentPage, key);
          if (runRef.current === runId && !found) {
            setDetailError(
              "This row wasn't found on the replica that answered. If this ClickHouse cluster has " +
              'multiple replicas, enable "Sequential consistency" for this view in Configuration.'
            );
          }
          return;
        }
        setHydratedRows((prev) => {
          const next = new Map(prev);
          next.set(logRowKey(fullRows[0], config), fullRows[0]);
          return next;
        });
      } catch (e) {
        // Gated on runId — see the matching comment in hydratePage's catch block above.
        if (runRef.current === runId) {
          setDetailError(errMsg(e));
        }
      } finally {
        hydratingRowKeysRef.current.delete(key);
        if (runRef.current === runId) {
          setDetailLoading(false);
        }
      }
    },
    [config, timeRange, queryState.useRawSql, hydratePage, currentPage]
  );

  useLayoutEffect(() => {
    latestExecuteQuery.current = executeQuery;
  });

  // Closes the 'render' span fetchLogs opened right before setRows(logRows) — see
  // pendingRenderSpanRef's declaration. Two steps, not one: useLayoutEffect fires synchronously
  // right after React has committed the new rows to the DOM, but before the browser has painted
  // them; requestAnimationFrame inside it fires just before the *next* paint, i.e. after this one
  // has happened. Ending the span in the layout effect itself would under-count by however long
  // the actual paint takes — the gap this span exists to measure in the first place.
  useLayoutEffect(() => {
    const span = pendingRenderSpanRef.current;
    if (!span) {
      return;
    }
    pendingRenderSpanRef.current = null;
    const frame = requestAnimationFrame(() => span.end('ok'));
    // Bounded backstop, not just a "did it fire" cleanup: browsers throttle requestAnimationFrame
    // to near-zero in a backgrounded/inactive tab, so relying only on rAF (or a cleanup that fires
    // "whenever the next unrelated rows change happens to land") can leave this span open for
    // seconds — reporting a multi-second "render" time that has nothing to do with actual paint
    // work (seen live: 8.74s). Capping it at 1s means the worst case is "reported as ~1s and
    // clearly a measurement artifact", never "reported as 8s and mistaken for a real perf problem".
    // end() is idempotent, so whichever of {rAF, timeout, unmount cleanup} fires first wins.
    const timeout = window.setTimeout(() => span.end('ok'), 1000);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
      span.end('ok');
    };
  }, [rows]);

  // Auto-refresh: re-run the query on a tunable interval via RefreshPicker. Reads through
  // latestExecuteQuery (kept fresh above) rather than closing over `executeQuery` directly, so
  // the interval doesn't need to be torn down and restarted on every queryState change.
  const [refreshInterval, setRefreshInterval] = useState<string>('30s');
  useEffect(() => {
    if (!refreshInterval || refreshInterval === RefreshPicker.offOption.value) {
      return;
    }
    const ms = rangeUtil.intervalToMs(refreshInterval);
    if (!ms) {
      return;
    }
    const id = window.setInterval(() => latestExecuteQuery.current('Auto-refresh'), ms);
    return () => window.clearInterval(id);
  }, [refreshInterval]);

  // Tracks the previous useRawSql value so the auto-run effect below can tell "just switched
  // into raw mode" apart from any other queryState change.
  const prevUseRawSql = useRef(queryState.useRawSql);

  // Coalescing window for both auto-run effects below: a rapid sequence of mutations (e.g.
  // several column adds, or a filter add immediately followed by a sort click) used to fire one
  // full query pair per mutation with no debounce at all. 200ms is short enough that a single
  // deliberate action still feels instant, but long enough to collapse a fast burst into one
  // request instead of N.
  const MUTATION_DEBOUNCE_MS = 200;

  useEffect(() => {
    // Entering raw-SQL mode alone shouldn't fetch: the textarea is seeded with whatever query
    // is already on screen (see onToggleRawSql), so there's nothing new to run yet — only the
    // explicit Run button / Ctrl+Enter (runRawSql) should trigger a request from here on.
    const enteringRawMode = !prevUseRawSql.current && queryState.useRawSql;
    prevUseRawSql.current = queryState.useRawSql;
    if (enteringRawMode) {
      return;
    }
    // Joins (or starts) the shared group action for whichever user change triggered this fetch —
    // see groupActionRef's declaration above. fetchLogs reads actionRef.current synchronously at
    // its very top, before its own first await, so setting it immediately before the call and
    // clearing it right after is safe (same window executeQuery relies on).
    const t = window.setTimeout(() => {
      actionRef.current = joinGroupAction();
      const p = fetchLogs();
      actionRef.current = null;
      trackGroupPromise(p);
    }, MUTATION_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // joinGroupAction/trackGroupPromise are plain (non-useCallback) helpers redefined every render
    // that close over current state via `queryState`/`effectiveColumns`/`timeRange`/refs — they're
    // deliberately excluded from deps (as several other effects in this file already do for
    // similar helpers) so this effect still only re-fires for its own real trigger
    // (fetchLogs identity / queryState.useRawSql), not on every unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchLogs, queryState.useRawSql]);

  // Runs independently of the logs fetch above — fetchVolume's own deps already exclude columns/
  // sort/raw-SQL, so this effect only re-fires for inputs that actually change the histogram
  // (time range, search, filters, interval, breakdown). Still joins the SAME group action as the
  // logs effect above when both fire for the same underlying change (see groupActionRef).
  useEffect(() => {
    const t = window.setTimeout(() => {
      actionRef.current = joinGroupAction();
      const p = fetchVolume();
      actionRef.current = null;
      trackGroupPromise(p);
    }, MUTATION_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // See the matching disable comment on the logs effect above — same reasoning applies here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchVolume]);

  const onAddFilter = (filter: FilterPill) => {
    dispatch({
      type: 'SET_FILTERS',
      filters: addFilterPill(queryState.filters, filter),
    });
  };

  const logsLoadValues = useCallback(
    (sqlExpr: string) => {
      // queryState.search is normally already-validated (SearchBar only commits a query that
      // parsed — see SearchBar.commit()), but a saved search or URL-restored query hasn't been
      // re-validated yet. buildWhereConditions now throws KqlSyntaxError instead of silently
      // degrading (see buildSearchClause), so this best-effort value lookup drops the search term
      // rather than rejecting — a stale value list is harmless; an unhandled promise rejection on
      // every keystroke of the value dropdown is not.
      let conditions: string[];
      try {
        conditions = buildWhereConditions(config, queryState, fieldIndex);
      } catch {
        conditions = buildWhereConditions(config, { ...queryState, search: '' }, fieldIndex);
      }
      return loadFieldValues(config, sqlExpr, {
        table: config.logsTable,
        conditions,
        timeRange,
        cacheKey: JSON.stringify([queryState.search, queryState.filters]),
      });
    },
    [config, queryState, timeRange, fieldIndex]
  );

  const onToggleColumn = (col: SelectedColumn) => {
    if (effectiveColumns.some((c) => c.id === col.id)) {
      dispatch({ type: 'REMOVE_COLUMN', id: col.id, columns: effectiveColumns });
    } else {
      dispatch({ type: 'ADD_COLUMN', col, columns: effectiveColumns });
    }
  };

  // Dragging a field out of FieldSidebar and dropping it on the table adds it as a column —
  // always an add (never a toggle-off), since the same field could be dropped again without
  // surprising the user by removing it.
  const onDropField = (fieldId: string, targetId?: string) => {
    const field = fieldsState.fields.find((f) => f.id === fieldId);
    if (field && !effectiveColumns.some((c) => c.id === field.id)) {
      dispatch({ type: 'ADD_COLUMN', col: fieldToColumn(field), columns: effectiveColumns, targetId });
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
    queueMicrotask(() => latestExecuteQuery.current('Load saved search'));
  };

  const onHistogramSelectRange = (fromMs: number, toMs: number) => {
    setTimeRange({
      from: dateTime(fromMs),
      to: dateTime(toMs),
      raw: { from: dateTime(fromMs), to: dateTime(toMs) },
    });
  };

  // Clicking a breakdown segment in the histogram pops up "filter for/out this value" (handled
  // inside VolumeHistogram) instead of the usual click-to-zoom. Wired for both
  // 'field' and 'severity' breakdowns — severity used to be excluded here (no field to filter by
  // was more true reasoning: this callback simply didn't handle it), which is why the severity
  // breakdown couldn't be filtered from the chart at all.
  const onHistogramBreakdownFilter = (value: string, op: '=' | '!=') => {
    if (breakdown.kind === 'field') {
      onAddFilter(makeFilter(breakdown.field.sqlExpr, value, op));
    } else if (breakdown.kind === 'severity' && config.columns.severity) {
      // buildVolumeQuery's severity breakdown no longer lower()s server-side (see queryBuilder.ts)
      // — `value` here is the real, as-stored casing, so a plain exact-match filter is correct.
      onAddFilter(makeFilter(config.columns.severity, value, op));
    }
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
        const chunk = await runQueryRows({
          datasourceUid: config.datasourceUid,
          sql,
          timeRange,
          signal: runAbortRef.current?.signal,
          op: 'loadMore',
        });
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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCompareSelection(new Set());
  }, [pageRows]);

  // Hydrate just the open row (see hydrateRow's doc comment) whenever the drawer opens or the
  // selection moves — covers both clicking a row and paging prev/next inside the drawer, since
  // both change `selectedRow`. No `currentPage` dependency: unlike the old whole-page hydrate,
  // a single-row lookup doesn't care which grid page the row happens to be on.
  useEffect(() => {
    if (selectedRow) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      hydrateRow(selectedRow);
    }
  }, [selectedRow, hydrateRow]);

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
    // Raw-SQL mode: `row` already is the full row (see hydrateRow's early return above), so treat
    // it as pre-hydrated instead of leaving the drawer waiting on a hydration that will never run.
    if (queryState.useRawSql) {
      return selectedRow;
    }
    return hydratedRows.get(logRowKey(selectedRow, config));
  }, [selectedRow, hydratedRows, queryState.useRawSql, config]);

  return (
    <FieldsContext.Provider value={fieldsState}>
      <PluginPage layout={PageLayoutType.Custom} pageNav={{ text: 'Logs' }}>
      <div ref={containerRef} className={styles.container} style={{ height: availableHeight }}>
        {/* Row 1: view picker + add filter + search (left/center) + saved/dashboard/time/refresh
            (right) — condensed onto one line (Kibana Discover style) so the table below gets the
            vertical space the search bar's own row used to take. SearchBar itself is the
            flex-growing element (replaces the old plain headerSpacer div) so it absorbs whatever
            width the fixed-size controls around it don't need. `.header`'s existing flex-wrap
            still applies on narrow viewports — DOM order means TimeRangePicker/RefreshPicker (the
            last items) wrap to a second line first, not SearchBar. */}
        <div className={styles.header}>
          <DataViewPicker />
          <AddFilterPopover loadValues={logsLoadValues} onAddFilter={onAddFilter} />
          {/* SearchBar's own root has width:100% (right for its old standalone row), which alone
              wouldn't grow to fill the remaining space in this shared flex row — wrap it so it
              does, independent of SearchBar's internal styling. */}
          <div className={styles.headerSearchWrap}>
            <SearchBar
              value={queryState.search}
              onChange={(v) => dispatch({ type: 'SET_SEARCH', value: v })}
              onSearch={() => {}}
              loadValues={logsLoadValues}
            />
          </div>
          {/* Grouped so they wrap together as one atomic unit when the row runs out of width —
              without this, flex-wrap can strand RefreshPicker alone on its own line while
              TimeRangePicker (which fit) stays on line 1, separating a control from the time
              range it refreshes. */}
          <div className={styles.headerTimeGroup}>
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
            <RefreshPicker
              onRefresh={() => executeQuery('Refresh')}
              onIntervalChanged={setRefreshInterval}
              value={refreshInterval}
              isLoading={loading}
              tooltip="Refresh"
              isOnCanvas
            />
          </div>
        </div>

        {/* Filter pills */}
        {queryState.filters.length > 0 && (
          <div className={styles.pills}>
            <FilterPills
              filters={queryState.filters}
              onChange={(f) => dispatch({ type: 'SET_FILTERS', filters: f })}
              loadValues={logsLoadValues}
            />
          </div>
        )}

        {/* SQL preview / edit */}
        <SqlInspectorBar
          queryState={{ ...queryState, columns: effectiveColumns }}
          timeRange={timeRange}
          activeViewId={activeView?.id}
          onLoadSaved={onLoadSaved}
          canAddToDashboard={canAddToDashboard}
          onOpenAddToDashboard={() => setAddToDashboardOpen(true)}
          onToggleRawSql={onToggleRawSql}
          showSqlInspect={showSqlInspect}
          onToggleShowSqlInspect={() => setShowSqlInspect((v) => !v)}
          rawSqlDraft={rawSqlDraft}
          onRawSqlDraftChange={setRawSqlDraft}
          onRunRawSql={runRawSql}
          builderSql={builderSql}
          onOpenDiagnostics={() => setShowDiagnostics(true)}
        />
        {showDiagnostics && <DiagnosticsDrawer onClose={() => setShowDiagnostics(false)} />}

        {/* Error banner */}
        {error && (
          <div className={styles.error}>
            <strong>Query error:</strong> {error}
          </div>
        )}

        {/* Two-pane: sidebar + results. The histogram now lives inside the results pane (below)
            instead of as a full-width row above it, so the sidebar spans the full height
            alongside it, rather than the sidebar only starting beneath the histogram. */}
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
                <Icon name="angle-double-right" size="sm" />
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
            <div
              {...(selectedRow ? detailSplitterProps : {})}
              className={cx(styles.tableDetailSplit, selectedRow && detailSplitterProps.className)}
            >
              <div
                {...(selectedRow ? tablePaneProps : {})}
                style={
                  selectedRow && detailExpanded
                    ? { ...tablePaneProps.style, flexGrow: 0, flexBasis: '12%' }
                    : selectedRow
                    ? tablePaneProps.style
                    : undefined
                }
                className={cx(styles.tablePane, selectedRow && tablePaneProps.className)}
              >
                {/* Histogram + toolbar live inside the table pane (not the results pane as a
                    whole) so they shrink along with the table when the detail panel opens,
                    instead of spanning the full width behind it. */}
                <LogsHistogramPanel
                  hasTime={caps.hasTime}
                  hasSeverity={caps.hasSeverity}
                  intervalMode={intervalMode}
                  onIntervalModeChange={setIntervalMode}
                  timeRange={timeRange}
                  breakdown={breakdown}
                  onBreakdownChange={setBreakdown}
                  volumeData={volumeData}
                  volLoading={volLoading}
                  totalEvents={totalEvents}
                  resolvedInterval={resolvedInterval}
                  onSelectRange={onHistogramSelectRange}
                  onBreakdownFilter={onHistogramBreakdownFilter}
                  collapsed={histogramCollapsed}
                  onToggleCollapsed={() => setHistogramCollapsed((v) => !v)}
                />
                <div className={styles.tableToolbar}>
                  {compareSelection.size >= 2 && (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon="columns"
                      onClick={() => {
                        // Compare needs every field, not just the currently displayed columns —
                        // pageRows are the narrow grid projection. Hydrate the full rows for this
                        // page the same way opening the detail panel does.
                        hydratePage(currentPage);
                        setCompareOpen(true);
                      }}
                    >
                      Compare ({compareSelection.size})
                    </Button>
                  )}
                  <label className={styles.wrapToggleLabel}>
                    <Switch value={wrapLines} onChange={(e) => setWrapLines(e.currentTarget.checked)} />
                    Wrap lines
                  </label>
                  <div className={styles.headerSpacer} />
                </div>
                <LogsTable
                  rows={pageRows}
                  loading={loading && rows.length === 0}
                  columns={effectiveColumns}
                  sort={queryState.sort}
                  onRowClick={(row) => {
                    if (selectedRow === row) {
                      setSelectedRow(null);
                      setDetailExpanded(false);
                    } else {
                      setSelectedRow(row);
                    }
                  }}
                  onSort={(col) => dispatch({ type: 'SET_SORT', col })}
                  onRemoveColumn={(col) => dispatch({ type: 'REMOVE_COLUMN', id: col.id, columns: effectiveColumns })}
                  onMoveColumn={(id, direction) => dispatch({ type: 'REORDER_COLUMN', id, direction, columns: effectiveColumns })}
                  onMoveColumnTo={(id, targetId) => dispatch({ type: 'MOVE_COLUMN_TO', id, targetId, columns: effectiveColumns })}
                  selectedRow={selectedRow}
                  wrapLines={wrapLines}
                  compareSelection={compareSelection}
                  onToggleCompare={onToggleCompare}
                  onAddFilter={onAddFilter}
                  onDropField={onDropField}
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
              {selectedRow && (
                <>
                  <div {...detailHandleProps} className={cx(detailHandleProps.className, styles.splitterHandle)} />
                  <div
                    {...detailPaneProps}
                    style={detailExpanded ? { ...detailPaneProps.style, flexGrow: 1, flexBasis: '88%' } : detailPaneProps.style}
                    className={cx(detailPaneProps.className, styles.detailPane)}
                  >
                    <LogDetailDrawer
                      row={selectedRow}
                      detailRow={detailRow}
                      detailLoading={detailLoading}
                      fieldsLoading={fieldsState.loading}
                      fieldsError={fieldsState.error}
                      detailError={detailError}
                      onRetryHydrate={() => {
                        if (!selectedRow) {
                          return;
                        }
                        const key = logRowKey(selectedRow, config);
                        hydratedRowsRef.current.delete(key);
                        hydratingRowKeysRef.current.delete(key);
                        setDetailError(null);
                        hydrateRow(selectedRow);
                      }}
                      config={config}
                      fields={fieldsState.fields}
                      columns={effectiveColumns}
                      onClose={() => {
                        setSelectedRow(null);
                        setDetailExpanded(false);
                      }}
                      expanded={detailExpanded}
                      onToggleExpanded={() => setDetailExpanded((v) => !v)}
                      onAddFilter={onAddFilter}
                      onToggleColumn={onToggleColumn}
                      getTraceHref={config.columns.traceId ? getTraceHref : undefined}
                      onPrev={selectedIndex > 0 ? () => setSelectedRow(pageRows[selectedIndex - 1]) : undefined}
                      onNext={
                        selectedIndex >= 0 && selectedIndex < pageRows.length - 1
                          ? () => setSelectedRow(pageRows[selectedIndex + 1])
                          : undefined
                      }
                      navLabel={selectedIndex >= 0 ? `${selectedIndex + 1} of ${pageRows.length}` : undefined}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {compareOpen && compareSelection.size >= 2 && (
          <CompareLogsModal
            rows={[...compareSelection]
              .sort((a, b) => a - b)
              .map((i) => pageRows[i])
              .map((row) => hydratedRows.get(logRowKey(row, config)) ?? row)}
            config={config}
            onDismiss={() => setCompareOpen(false)}
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
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    height: 100%;
    padding: ${theme.spacing(2)};
    gap: ${theme.spacing(1)};
    background: ${theme.colors.background.canvas};
  `,
  header: css`
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: ${theme.spacing(1)};
    row-gap: ${theme.spacing(0.5)};
  `,
  headerSpacer: css`
    flex: 1;
  `,
  headerSearchWrap: css`
    flex: 1 1 260px;
    min-width: 200px;
  `,
  headerTimeGroup: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    flex-shrink: 0;
  `,
  pills: css`
    min-height: 0;
  `,
  error: css`
    padding: ${theme.spacing(1)};
    background: ${theme.colors.error.transparent};
    border: 1px solid ${theme.colors.error.border};
    border-radius: ${theme.shape.radius.default};
    color: ${theme.colors.error.text};
    font-size: ${theme.typography.body.fontSize};
  `,
  body: css`
    flex: 1;
    min-height: 0;
    display: flex;
    overflow: hidden;
  `,
  sidebarPane: css`
    /* useSplitter sets an inline min-width: min-content on this pane, which floors it at
     * whatever its widest child (e.g. a long field name) needs — effectively locking the drag
     * handle in place well before the panel looks "small". Override with !important so dragging
     * can actually shrink it down close to the collapsed rail. */
    min-width: 60px !important;
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
    /* A touch lighter than the field sidebar (which stays on the page's canvas bg) — the tonal
       split reads as a distinct panel without needing a border. */
    background: ${theme.colors.background.primary};
  `,
  tableToolbar: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1.5)};
    padding-bottom: ${theme.spacing(0.5)};
  `,
  tableDetailSplit: css`
    flex: 1;
    width: 100%;
    min-height: 0;
    display: flex;
  `,
  tablePane: css`
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  detailPane: css`
    /* Same min-content override as sidebarPane — otherwise the panel's own content floors how
     * far it can be dragged. */
    min-width: 60px !important;
    overflow: hidden;
  `,
  wrapToggleLabel: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    font-size: ${theme.typography.body.fontSize};
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
