import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { dateTime, GrafanaTheme2, PageLayoutType, TimeRange } from '@grafana/data';
import { PluginPage } from '@grafana/runtime';
import { Button, Input, Select, Spinner, TabsBar, Tab, useStyles2, TimeRangePicker, Alert, IconButton } from '@grafana/ui';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { TraceWaterfall } from '../components/trace/TraceWaterfall';
import { SpanDetailDrawer } from '../components/trace/SpanDetailDrawer';
import { ServiceMap } from '../components/trace/ServiceMap';
import { TraceHeaderStats } from '../components/trace/TraceHeaderStats';
import { VolumeHistogram, resolveInterval, ResolvedInterval } from '../components/VolumeHistogram';
import { IntervalPicker } from '../components/HistogramControls/IntervalPicker';
import { PaginationBar } from '../components/PaginationBar';
import { runQueryRows } from '../data/runQuery';
import {
  buildTraceListQuery,
  buildTraceDetailQuery,
  buildTraceVolumeQuery,
  buildTraceWhereConditions,
  TraceListSort,
} from '../sql/queryBuilder';
import { loadFieldValues } from '../sql/kql/_values';
import { addFilterPill } from '../sql/filters';
import { parseMapValue } from '../sql/schema';
import { viewCapabilities } from '../sql/capabilities';
import { SourceConfigContext } from '../components/App/App';
import { FieldsProvider } from '../components/FieldsContext';
import { SearchBar } from '../components/SearchBar';
import { AddFilterPopover } from '../components/AddFilter/AddFilterPopover';
import { FilterPills } from '../components/FilterPills';
import { WaterfallNode, buildSpanTree } from '../sql/trace/tree';
import {
  DEFAULT_TRACE_LIST_FILTERS,
  FilterPill,
  IntervalMode,
  SpanEvent,
  SpanLink,
  SpanRow,
  TraceListFilters,
  TraceRow,
  VolumeDataPoint,
} from '../types';
import { PLUGIN_BASE_URL, ROUTES } from '../constants';
import { formatMs } from '../utils/traceFormat';
import { shiftTimeRange, zoomOutTimeRange } from '../utils/timeRangeNav';
import { useAvailableHeight } from '../utils/useAvailableHeight';

const INITIAL_FETCH = 100;
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const DEFAULT_PAGE_SIZE = 25;

type DetailView = 'waterfall' | 'servicemap';

function defaultTimeRange(): TimeRange {
  return {
    from: dateTime(Date.now() - 3600 * 1000),
    to: dateTime(Date.now()),
    raw: { from: 'now-1h', to: 'now' },
  };
}

function wideTimeRange(): TimeRange {
  // The detail query no longer needs the picker's range (it's bounded by the trace_id_ts MV
  // lookup instead), but runQuery still requires a TimeRange argument.
  return { from: dateTime(0), to: dateTime(Date.now() * 2), raw: { from: 'now-30d', to: 'now' } };
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') {
    return v;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Row → SpanRow, converting nanosecond-epoch aliases to the ms/ns invariant documented on SpanRow. */
function rowToSpan(r: Record<string, unknown>): SpanRow {
  const eventsTs = Array.isArray(r['eventsTimestamp']) ? (r['eventsTimestamp'] as unknown[]) : [];
  const eventsName = Array.isArray(r['eventsName']) ? (r['eventsName'] as unknown[]) : [];
  const eventsAttrs = Array.isArray(r['eventsAttributes']) ? (r['eventsAttributes'] as unknown[]) : [];
  const events: SpanEvent[] = eventsTs.map((ts, i) => ({
    timestamp: toNumber(ts) / 1e6,
    name: String(eventsName[i] ?? ''),
    attributes: parseMapValue(eventsAttrs[i]),
  }));

  const linksTraceId = Array.isArray(r['linksTraceId']) ? (r['linksTraceId'] as unknown[]) : [];
  const linksSpanId = Array.isArray(r['linksSpanId']) ? (r['linksSpanId'] as unknown[]) : [];
  const linksAttrs = Array.isArray(r['linksAttributes']) ? (r['linksAttributes'] as unknown[]) : [];
  const links: SpanLink[] = linksTraceId.map((tid, i) => ({
    traceId: String(tid ?? ''),
    spanId: String(linksSpanId[i] ?? ''),
    attributes: parseMapValue(linksAttrs[i]),
  }));

  return {
    traceId: String(r['traceId'] ?? ''),
    spanId: String(r['spanId'] ?? ''),
    parentSpanId: String(r['parentSpanId'] ?? ''),
    serviceName: String(r['serviceName'] ?? ''),
    operationName: String(r['operationName'] ?? ''),
    spanKind: String(r['spanKind'] ?? ''),
    startTime: toNumber(r['startNs']) / 1e6,
    durationNs: toNumber(r['durationNs']),
    statusCode: String(r['statusCode'] ?? ''),
    statusMessage: String(r['statusMessage'] ?? ''),
    attributes: (r['attributes'] ?? '') as string,
    resourceAttributes: (r['resourceAttributes'] ?? '') as string,
    events,
    links,
  };
}

function rowToTrace(r: Record<string, unknown>): TraceRow {
  const startNs = toNumber(r['startNs']);
  const endNs = toNumber(r['endNs']);
  return {
    traceId: String(r['traceId'] ?? ''),
    startTime: startNs / 1e6,
    endTime: endNs / 1e6,
    rootServiceName: String(r['rootServiceName'] ?? ''),
    rootOperationName: String(r['rootOperationName'] ?? ''),
    spanCount: toNumber(r['spanCount']),
    errorCount: toNumber(r['errorCount']),
    serviceCount: toNumber(r['serviceCount']),
    duration: toNumber(r['durationNs']),
  };
}

const STATUS_OPTIONS = [
  { label: 'Any status', value: 'any' as const },
  { label: 'Errors only', value: 'error' as const },
  { label: 'OK only', value: 'ok' as const },
];

export function TraceExplorer() {
  const styles = useStyles2(getStyles);
  const config = useContext(SourceConfigContext);
  const caps = viewCapabilities(config);
  const navigate = useNavigate();
  const { traceId: urlTraceId } = useParams<{ traceId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── List state ──────────────────────────────────────────────────────────
  const [filters, setFilters] = useState<TraceListFilters>(() => ({
    ...DEFAULT_TRACE_LIST_FILTERS,
    search: searchParams.get('q') ?? '',
  }));
  const [sort, setSort] = useState<TraceListSort>({ col: 'startTime', dir: 'desc' });
  const [timeRange, setTimeRange] = useState<TimeRange>(defaultTimeRange);
  const [intervalMode, setIntervalMode] = useState<IntervalMode>('auto');
  const [breakdownMode, setBreakdownMode] = useState<'status' | 'service' | 'none'>('status');

  const [traceRows, setTraceRows] = useState<TraceRow[]>([]);
  const [volumeData, setVolumeData] = useState<VolumeDataPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [currentPage, setCurrentPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [fetchingMore, setFetchingMore] = useState(false);

  const runRef = useRef(0);
  const latestSearchList = useRef<() => void>(() => {});

  // ── Detail state ────────────────────────────────────────────────────────
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(urlTraceId ?? null);
  const [spans, setSpans] = useState<SpanRow[]>([]);
  const [spansLoading, setSpansLoading] = useState(false);
  const [spansTruncated, setSpansTruncated] = useState(false);
  const [selectedSpan, setSelectedSpan] = useState<WaterfallNode | null>(null);
  const [detailView, setDetailView] = useState<DetailView>(
    (searchParams.get('view') as DetailView) === 'servicemap' ? 'servicemap' : 'waterfall'
  );
  const loadTraceRunRef = useRef(0);

  const tree = useMemo(() => buildSpanTree(spans), [spans]);

  // ── List query ──────────────────────────────────────────────────────────
  const searchTraces = useCallback(async () => {
    if (!config.datasourceUid) {
      setError('No ClickHouse datasource configured. Go to Configuration to set it up.');
      return;
    }
    const runId = ++runRef.current;
    setLoading(true);
    setError(null);
    try {
      const sql = buildTraceListQuery(config, filters, sort, { limit: INITIAL_FETCH, offset: 0 });
      if (!sql) {
        if (runRef.current === runId) {
          setError('Trace ID column is not mapped for this data view. Go to Configuration to set it up.');
          setLoading(false);
        }
        return;
      }
      const resolved: ResolvedInterval = resolveInterval(intervalMode, timeRange);
      const breakdown =
        breakdownMode === 'status'
          ? ({ kind: 'severity', expr: config.columns.statusCode } as const)
          : breakdownMode === 'service'
          ? ({ kind: 'field', expr: config.columns.serviceName, limit: 8 } as const)
          : ({ kind: 'none' } as const);
      const volSql = buildTraceVolumeQuery(config, filters, {
        interval: { unit: resolved.unit, value: resolved.value },
        breakdown,
      });
      const volPromise = caps.hasTime && volSql
        ? runQueryRows({ datasourceUid: config.datasourceUid, sql: volSql, timeRange, refId: 'trace-vol' })
        : Promise.resolve<Array<Record<string, unknown>>>([]);

      const [rows, volRows] = await Promise.all([
        runQueryRows({ datasourceUid: config.datasourceUid, sql, timeRange, refId: 'trace-list' }),
        volPromise,
      ]);

      if (runRef.current !== runId) {
        return;
      }
      setTraceRows(rows.map(rowToTrace));
      setCurrentPage(0);
      setHasMore(rows.length === INITIAL_FETCH);

      const volMap = new Map<number, Record<string, number>>();
      for (const r of volRows) {
        const t = toNumber(r['time']);
        const level = String(r['level'] ?? 'unknown').toLowerCase();
        const count = toNumber(r['count']);
        if (!volMap.has(t)) {
          volMap.set(t, {});
        }
        volMap.get(t)![level] = (volMap.get(t)![level] ?? 0) + count;
      }
      setVolumeData(
        Array.from(volMap.entries())
          .sort(([a], [b]) => a - b)
          .map(([time, levels]) => ({ time, levels }))
      );
    } catch (err) {
      if (runRef.current === runId) {
        setError(String((err as Error)?.message ?? err));
      }
    } finally {
      if (runRef.current === runId) {
        setLoading(false);
      }
    }
  }, [config, filters, sort, timeRange, intervalMode, breakdownMode, caps.hasTime]);

  useLayoutEffect(() => {
    latestSearchList.current = searchTraces;
  });

  useEffect(() => {
    if (!urlTraceId) {
      searchTraces();
    }
  }, [searchTraces, urlTraceId]);

  // Lazy load-more beyond the initial buffer, same LIMIT/OFFSET pattern as Logs Explorer.
  const ensureRows = useCallback(
    async (page: number, currentPageSize: number, currentRows: TraceRow[], currentHasMore: boolean) => {
      const needed = (page + 1) * currentPageSize;
      if (currentRows.length >= needed || !currentHasMore || !config.datasourceUid) {
        return currentRows;
      }
      setFetchingMore(true);
      try {
        const chunkSize = needed - currentRows.length;
        const sql = buildTraceListQuery(config, filters, sort, { limit: chunkSize, offset: currentRows.length });
        const chunk = await runQueryRows({ datasourceUid: config.datasourceUid, sql, timeRange, refId: 'trace-list-more' });
        const mapped = chunk.map(rowToTrace);
        const merged = [...currentRows, ...mapped];
        setTraceRows(merged);
        setHasMore(mapped.length === chunkSize);
        return merged;
      } finally {
        setFetchingMore(false);
      }
    },
    [config, filters, sort, timeRange]
  );

  const onPageChange = useCallback(
    async (page: number) => {
      const updated = await ensureRows(page, pageSize, traceRows, hasMore);
      const needed = (page + 1) * pageSize;
      if (updated.length > page * pageSize || needed <= updated.length) {
        setCurrentPage(page);
      }
    },
    [ensureRows, pageSize, traceRows, hasMore]
  );

  const pageRows = useMemo(
    () => traceRows.slice(currentPage * pageSize, currentPage * pageSize + pageSize),
    [traceRows, currentPage, pageSize]
  );

  // ── Detail query ────────────────────────────────────────────────────────
  const loadTrace = useCallback(
    async (traceId: string) => {
      if (!config.datasourceUid || !traceId) {
        return;
      }
      const runId = ++loadTraceRunRef.current;
      setSpansLoading(true);
      setError(null);
      try {
        const limit = 10_000;
        let sql = buildTraceDetailQuery(config, traceId, { limit });
        if (!sql) {
          if (loadTraceRunRef.current === runId) {
            setError('Trace ID column is not mapped for this data view.');
            setSpansLoading(false);
          }
          return;
        }
        let rows: Array<Record<string, unknown>>;
        try {
          rows = await runQueryRows({ datasourceUid: config.datasourceUid, sql, timeRange: wideTimeRange() });
        } catch (err) {
          // The trace_id_ts materialized view may not exist in every deployment — retry once
          // without it (a slower, unbounded-by-index but still LIMIT-bounded full scan).
          sql = buildTraceDetailQuery(config, traceId, { limit, useTraceIdIndex: false });
          rows = await runQueryRows({ datasourceUid: config.datasourceUid, sql, timeRange: wideTimeRange() });
        }
        if (loadTraceRunRef.current !== runId) {
          return;
        }
        setSpans(rows.map(rowToSpan));
        setSpansTruncated(rows.length >= limit);
        setSelectedSpan(null);
      } catch (err) {
        if (loadTraceRunRef.current === runId) {
          setError(String((err as Error)?.message ?? err));
        }
      } finally {
        if (loadTraceRunRef.current === runId) {
          setSpansLoading(false);
        }
      }
    },
    [config]
  );

  useEffect(() => {
    if (urlTraceId) {
      setSelectedTraceId(urlTraceId);
      loadTrace(urlTraceId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTraceId]);

  const onSelectTrace = (traceId: string) => {
    setSelectedTraceId(traceId);
    navigate(`${PLUGIN_BASE_URL}/${ROUTES.Traces}/${traceId}`);
    loadTrace(traceId);
  };

  const onBackToList = () => {
    setSelectedTraceId(null);
    setSpans([]);
    setSelectedSpan(null);
    navigate(`${PLUGIN_BASE_URL}/${ROUTES.Traces}`);
    latestSearchList.current();
  };

  const onViewTrace = (traceId: string) => {
    navigate(`${PLUGIN_BASE_URL}/${ROUTES.Traces}/${traceId}`);
    setSelectedTraceId(traceId);
    loadTrace(traceId);
  };

  const setDetailViewAndUrl = (view: DetailView) => {
    setDetailView(view);
    const next = new URLSearchParams(searchParams);
    next.set('view', view);
    setSearchParams(next, { replace: true });
  };

  const onSearchChange = (value: string) => {
    setFilters((f) => ({ ...f, search: value }));
    const next = new URLSearchParams(searchParams);
    if (value) {
      next.set('q', value);
    } else {
      next.delete('q');
    }
    setSearchParams(next, { replace: true });
  };

  const currentTrace = traceRows.find((t) => t.traceId === selectedTraceId);
  const containerRef = useRef<HTMLDivElement>(null);
  const availableHeight = useAvailableHeight(containerRef);

  const traceLoadValues = useCallback(
    (sqlExpr: string) =>
      loadFieldValues(config, sqlExpr, {
        table: config.tracesTable,
        conditions: buildTraceWhereConditions(config, filters),
        timeRange,
        cacheKey: JSON.stringify(filters),
      }),
    [config, filters, timeRange]
  );

  const onAddTracePill = (pill: FilterPill) => {
    setFilters((f) => ({ ...f, pills: addFilterPill(f.pills, pill) }));
  };

  // otel_traces has no ScopeAttributes column (unlike otel_logs) — Scope is just
  // ScopeName/ScopeVersion strings there, so only Resource/Span attributes are real Map columns
  // on this table (verified live: mapKeys(ScopeAttributes) throws UNKNOWN_IDENTIFIER on otel_traces).
  const traceMapColumns = useMemo(
    () => [config.columns.resourceAttributes, config.columns.spanAttributes].filter(Boolean),
    [config.columns.resourceAttributes, config.columns.spanAttributes]
  );

  return (
    <PluginPage layout={PageLayoutType.Custom} pageNav={{ text: 'Traces' }}>
      <FieldsProvider config={config} timeRange={timeRange} table={config.tracesTable} mapColumns={traceMapColumns}>
      <div ref={containerRef} className={styles.container} style={{ height: availableHeight }}>
        <div className={styles.header}>
          <h2 className={styles.title}>
            {selectedTraceId ? (
              <>
                <button className={styles.backBtn} onClick={onBackToList}>
                  ← Traces
                </button>
              </>
            ) : (
              'Trace Explorer'
            )}
          </h2>
          {!selectedTraceId && (
            <TimeRangePicker
              value={timeRange}
              onChange={setTimeRange}
              onChangeTimeZone={() => {}}
              onChangeFiscalYearStartMonth={() => {}}
              onMoveBackward={() => setTimeRange(shiftTimeRange(timeRange, -1))}
              onMoveForward={() => setTimeRange(shiftTimeRange(timeRange, 1))}
              onZoom={() => setTimeRange(zoomOutTimeRange(timeRange))}
              timeZone="browser"
              fiscalYearStartMonth={0}
            />
          )}
        </div>

        {error && (
          <Alert severity="error" title="Query error">
            {error}
          </Alert>
        )}

        {/* ── Detail ─────────────────────────────────────────────────────── */}
        {selectedTraceId && (
          <div className={styles.detailContainer}>
            {spansLoading ? (
              <div className={styles.centered}>
                <Spinner />
              </div>
            ) : (
              <>
                <TraceHeaderStats
                  traceId={selectedTraceId}
                  rootServiceName={currentTrace?.rootServiceName ?? spans.find((s) => !s.parentSpanId)?.serviceName ?? ''}
                  rootOperationName={
                    currentTrace?.rootOperationName ?? spans.find((s) => !s.parentSpanId)?.operationName ?? ''
                  }
                  durationMs={tree.totalMs}
                  spanCount={spans.length}
                  serviceCount={new Set(spans.map((s) => s.serviceName)).size}
                  errorCount={spans.filter((s) => s.statusCode === 'STATUS_CODE_ERROR').length}
                  maxDepth={tree.maxDepth}
                />
                <TabsBar>
                  <Tab
                    label="Waterfall"
                    active={detailView === 'waterfall'}
                    onChangeTab={() => setDetailViewAndUrl('waterfall')}
                    icon="brackets-curly"
                  />
                  <Tab
                    label="Service map"
                    active={detailView === 'servicemap'}
                    onChangeTab={() => setDetailViewAndUrl('servicemap')}
                    icon="apps"
                  />
                </TabsBar>
                <div className={styles.detailBody}>
                  {detailView === 'waterfall' ? (
                    <TraceWaterfall
                      spans={spans}
                      selectedSpanKey={selectedSpan?.key}
                      onSelectSpan={setSelectedSpan}
                      truncated={spansTruncated}
                    />
                  ) : (
                    <ServiceMap spans={spans} />
                  )}
                </div>
              </>
            )}
            {selectedSpan && (
              <SpanDetailDrawer
                span={selectedSpan.span}
                traceTotalMs={tree.totalMs}
                config={config}
                onClose={() => setSelectedSpan(null)}
                onFilterService={(service) => {
                  onBackToList();
                  setFilters((f) => ({ ...f, service }));
                }}
                onFilterOperation={(operation) => {
                  onBackToList();
                  setFilters((f) => ({ ...f, spanName: operation }));
                }}
                onViewTrace={onViewTrace}
              />
            )}
          </div>
        )}

        {/* ── List ───────────────────────────────────────────────────────── */}
        {!selectedTraceId && (
          <>
            <div className={styles.filterRow}>
              <SearchBar
                value={filters.search}
                onChange={onSearchChange}
                onSearch={searchTraces}
                loadValues={traceLoadValues}
                placeholder="Search traces with KQL  ·  serviceName:api-gateway and statusCode:Error"
              />
              <AddFilterPopover onAddFilter={onAddTracePill} loadValues={traceLoadValues} />
              <Input
                className={styles.filterInput}
                value={filters.service}
                onChange={(e) => setFilters((f) => ({ ...f, service: e.currentTarget.value }))}
                placeholder="Service…"
                onKeyDown={(e) => e.key === 'Enter' && searchTraces()}
              />
              <Input
                className={styles.filterInput}
                value={filters.spanName}
                onChange={(e) => setFilters((f) => ({ ...f, spanName: e.currentTarget.value }))}
                placeholder="Operation…"
                onKeyDown={(e) => e.key === 'Enter' && searchTraces()}
              />
              <Select
                width={16}
                value={filters.status}
                options={STATUS_OPTIONS}
                onChange={(v) => setFilters((f) => ({ ...f, status: v.value ?? 'any' }))}
              />
              <Button onClick={searchTraces} disabled={loading} icon="search">
                Search
              </Button>
            </div>

            {filters.pills.length > 0 && (
              <div className={styles.pillsRow}>
                <FilterPills
                  filters={filters.pills}
                  onChange={(pills) => setFilters((f) => ({ ...f, pills }))}
                />
              </div>
            )}

            {caps.hasTime && (
              <div className={styles.histogramSection}>
                <div className={styles.histogramControls}>
                  <IntervalPicker value={intervalMode} onChange={setIntervalMode} timeRange={timeRange} />
                  <Select
                    width={20}
                    value={breakdownMode}
                    options={[
                      { label: 'No breakdown', value: 'none' as const },
                      { label: 'By status', value: 'status' as const },
                      { label: 'By service', value: 'service' as const },
                    ]}
                    onChange={(v) => setBreakdownMode(v.value ?? 'status')}
                  />
                  <span className={styles.eventCount}>
                    {traceRows.reduce((sum, t) => sum + t.spanCount, 0).toLocaleString()} spans across{' '}
                    {traceRows.length.toLocaleString()} traces (loaded)
                  </span>
                </div>
                <VolumeHistogram
                  data={volumeData}
                  timeRange={timeRange}
                  colorMode={breakdownMode === 'none' ? 'single' : breakdownMode === 'status' ? 'severity' : 'breakdown'}
                  bucketMs={resolveInterval(intervalMode, timeRange).intervalMs}
                  onSelectRange={(from, to) => setTimeRange({ from: dateTime(from), to: dateTime(to), raw: { from: dateTime(from), to: dateTime(to) } })}
                />
              </div>
            )}

            <div className={styles.tableWrapper}>
              {loading ? (
                <div className={styles.centered}>
                  <Spinner />
                </div>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th className={styles.th}>Trace ID</th>
                      <th className={styles.th}>Root service</th>
                      <th className={styles.th}>Root operation</th>
                      <th className={styles.th}>Start</th>
                      <th
                        className={`${styles.th} ${styles.thSortable}`}
                        onClick={() => setSort((s) => ({ col: 'duration', dir: s.col === 'duration' && s.dir === 'desc' ? 'asc' : 'desc' }))}
                      >
                        Duration {sort.col === 'duration' && <IconButton name={sort.dir === 'desc' ? 'angle-down' : 'angle-up'} tooltip="" size="sm" />}
                      </th>
                      <th className={styles.th}>Services</th>
                      <th className={styles.th}>Spans</th>
                      <th className={styles.th}>Errors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.length === 0 && (
                      <tr>
                        <td colSpan={8} className={styles.emptyTd}>
                          No traces found.
                        </td>
                      </tr>
                    )}
                    {pageRows.map((t) => (
                      <tr key={t.traceId} className={styles.tr} onClick={() => onSelectTrace(t.traceId)}>
                        <td className={styles.td}>
                          <span className={styles.traceId}>{t.traceId.slice(0, 16)}…</span>
                        </td>
                        <td className={styles.td}>{t.rootServiceName || '—'}</td>
                        <td className={styles.tdOp}>{t.rootOperationName || '—'}</td>
                        <td className={styles.td}>{new Date(t.startTime).toLocaleTimeString()}</td>
                        <td className={styles.td}>{formatMs(t.duration / 1e6)}</td>
                        <td className={styles.td}>{t.serviceCount}</td>
                        <td className={styles.td}>{t.spanCount}</td>
                        <td className={styles.td}>
                          {t.errorCount > 0 ? <span className={styles.errCount}>{t.errorCount}</span> : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <PaginationBar
              page={currentPage}
              pageSize={pageSize}
              pageSizeOptions={PAGE_SIZE_OPTIONS}
              totalLoaded={traceRows.length}
              hasMore={hasMore}
              fetchingMore={fetchingMore}
              onPageChange={onPageChange}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setCurrentPage(0);
              }}
            />
          </>
        )}
      </div>
      </FieldsProvider>
    </PluginPage>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: ${theme.spacing(2)};
    gap: ${theme.spacing(1.5)};
    background: ${theme.colors.background.canvas};
    min-height: 0;
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
    margin: 0;
    flex: 1;
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  backBtn: css`
    background: transparent;
    border: none;
    cursor: pointer;
    color: ${theme.colors.primary.text};
    font-size: ${theme.typography.body.fontSize};
    padding: 0;
    &:hover {
      text-decoration: underline;
    }
  `,
  filterRow: css`
    display: flex;
    gap: ${theme.spacing(1)};
    flex-wrap: wrap;
    align-items: center;
  `,
  filterInput: css`
    flex: 1;
    min-width: 140px;
  `,
  pillsRow: css`
    display: flex;
    flex-wrap: wrap;
  `,
  histogramSection: css`
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
    padding: ${theme.spacing(1)};
  `,
  histogramControls: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    margin-bottom: ${theme.spacing(0.5)};
  `,
  eventCount: css`
    margin-left: auto;
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  tableWrapper: css`
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  th: css`
    padding: ${theme.spacing(0.75)} ${theme.spacing(1)};
    text-align: left;
    border-bottom: 1px solid ${theme.colors.border.medium};
    background: ${theme.colors.background.secondary};
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
    position: sticky;
    top: 0;
    z-index: 1;
  `,
  thSortable: css`
    cursor: pointer;
    &:hover {
      color: ${theme.colors.text.primary};
    }
  `,
  tr: css`
    cursor: pointer;
    border-bottom: 1px solid ${theme.colors.border.weak};
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  td: css`
    padding: ${theme.spacing(0.75)} ${theme.spacing(1)};
    font-family: ${theme.typography.fontFamilyMonospace};
    white-space: nowrap;
  `,
  tdOp: css`
    padding: ${theme.spacing(0.75)} ${theme.spacing(1)};
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  emptyTd: css`
    padding: ${theme.spacing(4)};
    text-align: center;
    color: ${theme.colors.text.secondary};
  `,
  traceId: css`
    color: ${theme.colors.primary.text};
  `,
  errCount: css`
    color: ${theme.colors.error.text};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  detailContainer: css`
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    gap: ${theme.spacing(1)};
  `,
  detailBody: css`
    flex: 1;
    min-height: 0;
    overflow: auto;
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
  `,
  centered: css`
    display: flex;
    align-items: center;
    justify-content: center;
    height: 200px;
  `,
});
