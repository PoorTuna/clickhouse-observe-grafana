import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { dateTime, GrafanaTheme2, TimeRange } from '@grafana/data';
import { Button, Input, Spinner, useStyles2, TimeRangePicker } from '@grafana/ui';
import { TraceWaterfall } from '../components/TraceWaterfall';
import { runQueryRows } from '../data/runQuery';
import { buildTraceSearchQuery, buildTraceDetailQuery } from '../sql/queryBuilder';
import { SourceConfigContext } from '../components/App/App';
import { SpanRow, TraceRow } from '../types';
import { useParams, useNavigate } from 'react-router-dom';
import { PLUGIN_BASE_URL, ROUTES } from '../constants';

function defaultTimeRange(): TimeRange {
  return {
    from: dateTime(Date.now() - 3600 * 1000),
    to: dateTime(Date.now()),
    raw: { from: 'now-1h', to: 'now' },
  };
}

export function TraceExplorer() {
  const styles = useStyles2(getStyles);
  const config = useContext(SourceConfigContext);
  const navigate = useNavigate();
  const { traceId: urlTraceId } = useParams<{ traceId?: string }>();

  const [search, setSearch] = useState('');
  const [timeRange, setTimeRange] = useState<TimeRange>(defaultTimeRange);
  const [traceRows, setTraceRows] = useState<TraceRow[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(urlTraceId ?? null);
  const [spans, setSpans] = useState<SpanRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [spansLoading, setSpansLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runRef = useRef(0);

  // Search traces
  const searchTraces = useCallback(async () => {
    if (!config.datasourceUid) {
      return;
    }
    const runId = ++runRef.current;
    setLoading(true);
    setError(null);

    try {
      const sql = buildTraceSearchQuery(config, search);
      const rows = await runQueryRows({ datasourceUid: config.datasourceUid, sql, timeRange });

      if (runRef.current !== runId) {
        return;
      }

      setTraceRows(
        rows.map((r) => ({
          traceId: String(r['traceId'] ?? ''),
          startTime: Number(r['startTime'] ?? 0),
          endTime: Number(r['endTime'] ?? 0),
          serviceName: String(r['serviceName'] ?? ''),
          spanCount: Number(r['spanCount'] ?? 0),
          errorCount: Number(r['errorCount'] ?? 0),
          duration: Number(r['durationNs'] ?? 0),
        }))
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
  }, [config, search, timeRange]);

  // Load trace detail when a trace is selected
  const loadTrace = useCallback(
    async (traceId: string) => {
      if (!config.datasourceUid || !traceId) {
        return;
      }
      setSpansLoading(true);
      try {
        const sql = buildTraceDetailQuery(config, traceId);
        const rows = await runQueryRows({
          datasourceUid: config.datasourceUid,
          sql,
          timeRange: { from: dateTime(0), to: dateTime(Date.now() * 2), raw: { from: 'now-30d', to: 'now' } },
        });

        setSpans(
          rows.map((r) => ({
            traceID: String(r['traceID'] ?? ''),
            spanID: String(r['spanID'] ?? ''),
            parentSpanID: String(r['parentSpanID'] ?? ''),
            serviceName: String(r['serviceName'] ?? ''),
            operationName: String(r['operationName'] ?? ''),
            startTime: Number(r['startTime'] ?? 0),
            durationNs: Number(r['durationNs'] ?? 0),
            statusCode: String(r['statusCode'] ?? ''),
            tags: String(r['tags'] ?? ''),
          }))
        );
      } catch (err) {
        setError(String((err as Error)?.message ?? err));
      } finally {
        setSpansLoading(false);
      }
    },
    [config]
  );

  // Auto-search on mount and time range change
  useEffect(() => {
    if (!urlTraceId) {
      searchTraces();
    }
  }, [timeRange]);

  // Load trace if coming from URL param
  useEffect(() => {
    if (urlTraceId) {
      setSelectedTraceId(urlTraceId);
      loadTrace(urlTraceId);
    }
  }, [urlTraceId]);

  const onSelectTrace = (traceId: string) => {
    setSelectedTraceId(traceId);
    navigate(`${PLUGIN_BASE_URL}/${ROUTES.Traces}/${traceId}`);
    loadTrace(traceId);
  };

  const onBackToList = () => {
    setSelectedTraceId(null);
    setSpans([]);
    navigate(`${PLUGIN_BASE_URL}/${ROUTES.Traces}`);
    searchTraces();
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>
          {selectedTraceId ? (
            <>
              <button className={styles.backBtn} onClick={onBackToList}>
                ← Traces
              </button>
              <span className={styles.traceIdDisplay}>{selectedTraceId}</span>
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
            onMoveBackward={() => {}}
            onMoveForward={() => {}}
            onZoom={() => {}}
            timeZone="browser"
            fiscalYearStartMonth={0}
          />
        )}
      </div>

      {error && (
        <div className={styles.error}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Waterfall view */}
      {selectedTraceId && (
        <div className={styles.waterfallContainer}>
          {spansLoading ? (
            <div className={styles.centered}>
              <Spinner />
            </div>
          ) : (
            <TraceWaterfall spans={spans} />
          )}
        </div>
      )}

      {/* Trace search list */}
      {!selectedTraceId && (
        <>
          <div className={styles.searchRow}>
            <Input
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              placeholder="Filter by service name…"
              onKeyDown={(e) => e.key === 'Enter' && searchTraces()}
              prefix={<span>🔍</span>}
            />
            <Button onClick={searchTraces} disabled={loading} variant="secondary">
              Search
            </Button>
          </div>

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
                    <th className={styles.th}>Service</th>
                    <th className={styles.th}>Start</th>
                    <th className={styles.th}>Duration</th>
                    <th className={styles.th}>Spans</th>
                    <th className={styles.th}>Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {traceRows.length === 0 && (
                    <tr>
                      <td colSpan={6} className={styles.emptyTd}>
                        No traces found.
                      </td>
                    </tr>
                  )}
                  {traceRows.map((t) => (
                    <tr
                      key={t.traceId}
                      className={styles.tr}
                      onClick={() => onSelectTrace(t.traceId)}
                    >
                      <td className={styles.td}>
                        <span className={styles.traceId}>{t.traceId.slice(0, 16)}…</span>
                      </td>
                      <td className={styles.td}>{t.serviceName}</td>
                      <td className={styles.td}>{new Date(t.startTime).toLocaleTimeString()}</td>
                      <td className={styles.td}>
                        {t.duration >= 1e6
                          ? `${(t.duration / 1e6).toFixed(1)}ms`
                          : `${(t.duration / 1e3).toFixed(0)}µs`}
                      </td>
                      <td className={styles.td}>{t.spanCount}</td>
                      <td className={styles.td}>
                        {t.errorCount > 0 ? (
                          <span className={styles.errCount}>{t.errorCount}</span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
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
  traceIdDisplay: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 400px;
  `,
  searchRow: css`
    display: flex;
    gap: ${theme.spacing(1)};
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
  error: css`
    padding: ${theme.spacing(1)};
    background: ${theme.colors.error.transparent};
    border: 1px solid ${theme.colors.error.border};
    border-radius: ${theme.shape.radius.default};
    color: ${theme.colors.error.text};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  waterfallContainer: css`
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
