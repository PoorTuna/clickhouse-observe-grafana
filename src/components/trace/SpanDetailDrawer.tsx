import React, { useEffect, useState } from 'react';
import { css } from '@emotion/css';
import { dateTime, GrafanaTheme2, dateTimeFormat } from '@grafana/data';
import { useStyles2, Drawer, Button, Icon, Badge, Spinner } from '@grafana/ui';
import { SourceConfig, SpanEvent, SpanLink, SpanRow } from '../../types';
import { parseMapValue } from '../../sql/schema';
import { buildLogsByTraceIdQuery } from '../../sql/queryBuilder';
import { runQueryRows } from '../../data/runQuery';
import { serviceColor } from '../../constants';
import { formatNs } from '../../utils/traceFormat';

interface SpanDetailDrawerProps {
  span: SpanRow;
  /** Total trace duration in ms, for the "% of trace" stat. */
  traceTotalMs: number;
  config: SourceConfig;
  onClose: () => void;
  onFilterService?: (service: string) => void;
  onFilterOperation?: (operation: string) => void;
  onViewTrace?: (traceId: string) => void;
}

const TS_FORMAT = { format: 'YYYY-MM-DD HH:mm:ss.SSS', timeZone: 'browser' } as const;

interface LogRow {
  timestamp: unknown;
  body: unknown;
  severity: unknown;
}

export function SpanDetailDrawer({
  span,
  traceTotalMs,
  config,
  onClose,
  onFilterService,
  onFilterOperation,
  onViewTrace,
}: SpanDetailDrawerProps) {
  const styles = useStyles2(getStyles);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['overview', 'attributes', 'events']));
  const [logs, setLogs] = useState<LogRow[] | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  useEffect(() => {
    if (!config.datasourceUid || !config.columns.traceId || !config.logsTable) {
      return;
    }
    let cancelled = false;
    setLogsLoading(true);
    setLogsError(null);
    const sql = buildLogsByTraceIdQuery(config, span.traceId);
    if (!sql) {
      setLogsLoading(false);
      return;
    }
    runQueryRows({
      datasourceUid: config.datasourceUid,
      sql,
      timeRange: { from: dateTime(0), to: dateTime(Date.now() * 2), raw: { from: 'now-30d', to: 'now' } },
    })
      .then((rows) => {
        if (!cancelled) {
          setLogs(rows as unknown as LogRow[]);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setLogsError(String((err as Error)?.message ?? err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLogsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [span.traceId, config.datasourceUid]);

  const attrs = parseMapValue(span.attributes);
  const resourceAttrs = parseMapValue(span.resourceAttributes);
  const isError = span.statusCode === 'STATUS_CODE_ERROR';
  const pctOfTrace = traceTotalMs > 0 ? Math.min((span.durationNs / 1e6 / traceTotalMs) * 100, 100) : 0;

  return (
    <Drawer title="Span Detail" subtitle={span.operationName || span.spanId} onClose={onClose} size="md" scrollableContent>
      <div className={styles.content}>
        {/* Overview */}
        <section className={styles.section}>
          <button className={styles.sectionHeader} onClick={() => toggle('overview')}>
            <Icon name={expanded.has('overview') ? 'angle-down' : 'angle-right'} />
            <span>Overview</span>
          </button>
          {expanded.has('overview') && (
            <div className={styles.overviewBody}>
              <div className={styles.overviewRow}>
                <span className={styles.overviewLabel}>Service</span>
                <span className={styles.serviceDot} style={{ background: serviceColor(span.serviceName) }} />
                <span className={styles.overviewValue}>{span.serviceName || '(unknown)'}</span>
                {onFilterService && (
                  <Button size="sm" variant="secondary" fill="text" onClick={() => onFilterService(span.serviceName)}>
                    Filter
                  </Button>
                )}
              </div>
              <div className={styles.overviewRow}>
                <span className={styles.overviewLabel}>Operation</span>
                <span className={styles.overviewValue}>{span.operationName || '(unnamed)'}</span>
                {onFilterOperation && (
                  <Button size="sm" variant="secondary" fill="text" onClick={() => onFilterOperation(span.operationName)}>
                    Filter
                  </Button>
                )}
              </div>
              <div className={styles.overviewRow}>
                <span className={styles.overviewLabel}>Span kind</span>
                <span className={styles.overviewValue}>{span.spanKind || 'unknown'}</span>
              </div>
              <div className={styles.overviewRow}>
                <span className={styles.overviewLabel}>Duration</span>
                <span className={styles.overviewValue}>
                  {formatNs(span.durationNs)}
                  <span className={styles.pctOfTrace}> ({pctOfTrace.toFixed(1)}% of trace)</span>
                </span>
              </div>
              <div className={styles.overviewRow}>
                <span className={styles.overviewLabel}>Start</span>
                <span className={styles.overviewValue}>{dateTimeFormat(span.startTime, TS_FORMAT)}</span>
              </div>
              <div className={styles.overviewRow}>
                <span className={styles.overviewLabel}>Status</span>
                <span className={styles.overviewValue}>
                  {isError ? (
                    <Badge color="red" text={span.statusCode} icon="exclamation-triangle" />
                  ) : (
                    <Badge color="green" text={span.statusCode || 'unset'} />
                  )}
                  {span.statusMessage && <span className={styles.statusMessage}>{span.statusMessage}</span>}
                </span>
              </div>
              <div className={styles.overviewRow}>
                <span className={styles.overviewLabel}>Span ID</span>
                <span className={`${styles.overviewValue} ${styles.mono}`}>{span.spanId || '(empty)'}</span>
              </div>
              <div className={styles.overviewRow}>
                <span className={styles.overviewLabel}>Trace ID</span>
                <span className={`${styles.overviewValue} ${styles.mono}`}>{span.traceId}</span>
              </div>
            </div>
          )}
        </section>

        {/* Span attributes */}
        <AttrSection
          id="attributes"
          label="Span Attributes"
          attrs={attrs}
          expanded={expanded.has('attributes')}
          onToggle={() => toggle('attributes')}
          styles={styles}
        />

        {/* Resource attributes */}
        <AttrSection
          id="resource"
          label="Resource Attributes"
          attrs={resourceAttrs}
          expanded={expanded.has('resource')}
          onToggle={() => toggle('resource')}
          styles={styles}
        />

        {/* Events */}
        <section className={styles.section}>
          <button className={styles.sectionHeader} onClick={() => toggle('events')}>
            <Icon name={expanded.has('events') ? 'angle-down' : 'angle-right'} />
            <span>Events</span>
            <span className={styles.count}>{span.events.length}</span>
          </button>
          {expanded.has('events') && (
            <div className={styles.attrList}>
              {span.events.length === 0 && <div className={styles.emptyHint}>No events on this span.</div>}
              {span.events.map((event, i) => (
                <EventRow key={i} event={event} styles={styles} />
              ))}
            </div>
          )}
        </section>

        {/* Links */}
        <section className={styles.section}>
          <button className={styles.sectionHeader} onClick={() => toggle('links')}>
            <Icon name={expanded.has('links') ? 'angle-down' : 'angle-right'} />
            <span>Links</span>
            <span className={styles.count}>{span.links.length}</span>
          </button>
          {expanded.has('links') && (
            <div className={styles.attrList}>
              {span.links.length === 0 && <div className={styles.emptyHint}>No links on this span.</div>}
              {span.links.map((link, i) => (
                <LinkRow key={i} link={link} onViewTrace={onViewTrace} styles={styles} />
              ))}
            </div>
          )}
        </section>

        {/* Correlated logs */}
        <section className={styles.section}>
          <button className={styles.sectionHeader} onClick={() => toggle('logs')}>
            <Icon name={expanded.has('logs') ? 'angle-down' : 'angle-right'} />
            <span>Logs for this trace</span>
            {logs && <span className={styles.count}>{logs.length}</span>}
          </button>
          {expanded.has('logs') && (
            <div className={styles.attrList}>
              {logsLoading && (
                <div className={styles.emptyHint}>
                  <Spinner inline /> Loading correlated logs…
                </div>
              )}
              {logsError && <div className={styles.emptyHint}>{logsError}</div>}
              {!logsLoading && !logsError && logs && logs.length === 0 && (
                <div className={styles.emptyHint}>No logs found for this trace.</div>
              )}
              {logs?.map((log, i) => (
                <div key={i} className={styles.logLine}>
                  <span className={styles.logTs}>{String(log.timestamp)}</span>
                  {log.severity ? <span className={styles.logSeverity}>{String(log.severity)}</span> : null}
                  <span className={styles.logBody}>{String(log.body ?? '')}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </Drawer>
  );
}

function AttrSection({
  id,
  label,
  attrs,
  expanded,
  onToggle,
  styles,
}: {
  id: string;
  label: string;
  attrs: Record<string, string>;
  expanded: boolean;
  onToggle: () => void;
  styles: ReturnType<typeof getStyles>;
}) {
  const entries = Object.entries(attrs);
  return (
    <section className={styles.section}>
      <button className={styles.sectionHeader} onClick={onToggle}>
        <Icon name={expanded ? 'angle-down' : 'angle-right'} />
        <span>{label}</span>
        <span className={styles.count}>{entries.length}</span>
      </button>
      {expanded && (
        <div className={styles.attrList}>
          {entries.length === 0 && <div className={styles.emptyHint}>None.</div>}
          {entries.map(([k, v]) => (
            <div key={k} className={styles.attrRow}>
              <span className={styles.attrKey}>{k}</span>
              <span className={styles.attrValue}>{v}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function EventRow({ event, styles }: { event: SpanEvent; styles: ReturnType<typeof getStyles> }) {
  const isException = event.name === 'exception' || 'exception.stacktrace' in event.attributes;
  const stacktrace = event.attributes['exception.stacktrace'];
  return (
    <div className={styles.eventRow}>
      <div className={styles.eventHeader}>
        {isException && <Icon name="exclamation-triangle" size="sm" className={styles.exceptionIcon} />}
        <span className={styles.eventName}>{event.name}</span>
        <span className={styles.eventTs}>{dateTimeFormat(event.timestamp, TS_FORMAT)}</span>
      </div>
      {Object.entries(event.attributes)
        .filter(([k]) => k !== 'exception.stacktrace')
        .map(([k, v]) => (
          <div key={k} className={styles.attrRow}>
            <span className={styles.attrKey}>{k}</span>
            <span className={styles.attrValue}>{v}</span>
          </div>
        ))}
      {stacktrace && <pre className={styles.stacktrace}>{stacktrace}</pre>}
    </div>
  );
}

function LinkRow({
  link,
  onViewTrace,
  styles,
}: {
  link: SpanLink;
  onViewTrace?: (traceId: string) => void;
  styles: ReturnType<typeof getStyles>;
}) {
  return (
    <div className={styles.linkRow}>
      <div className={styles.attrRow}>
        <span className={styles.attrKey}>traceId</span>
        <span className={`${styles.attrValue} ${styles.mono}`}>{link.traceId}</span>
      </div>
      <div className={styles.attrRow}>
        <span className={styles.attrKey}>spanId</span>
        <span className={`${styles.attrValue} ${styles.mono}`}>{link.spanId}</span>
      </div>
      {onViewTrace && (
        <Button size="sm" variant="secondary" icon="external-link-alt" onClick={() => onViewTrace(link.traceId)}>
          View trace
        </Button>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  content: css`
    padding: ${theme.spacing(1)};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  section: css`
    margin-bottom: ${theme.spacing(0.5)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    overflow: hidden;
  `,
  sectionHeader: css`
    width: 100%;
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    padding: ${theme.spacing(0.75)} ${theme.spacing(1)};
    background: ${theme.colors.background.secondary};
    border: none;
    cursor: pointer;
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
    text-align: left;
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  count: css`
    margin-left: auto;
    color: ${theme.colors.text.secondary};
    font-size: 11px;
    font-weight: normal;
  `,
  overviewBody: css`
    padding: ${theme.spacing(1)};
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.5)};
  `,
  overviewRow: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  overviewLabel: css`
    width: 90px;
    flex-shrink: 0;
    color: ${theme.colors.text.secondary};
  `,
  overviewValue: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    color: ${theme.colors.text.primary};
  `,
  pctOfTrace: css`
    color: ${theme.colors.text.secondary};
    font-size: 11px;
  `,
  statusMessage: css`
    color: ${theme.colors.error.text};
    font-style: italic;
  `,
  serviceDot: css`
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  `,
  mono: css`
    font-family: ${theme.typography.fontFamilyMonospace};
  `,
  attrList: css`
    padding: ${theme.spacing(0.5)};
  `,
  attrRow: css`
    display: flex;
    align-items: flex-start;
    gap: ${theme.spacing(0.5)};
    padding: ${theme.spacing(0.25)} ${theme.spacing(0.5)};
    border-radius: ${theme.shape.radius.default};
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  attrKey: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    color: ${theme.colors.text.secondary};
    min-width: 160px;
    flex-shrink: 0;
    word-break: break-all;
  `,
  attrValue: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    color: ${theme.colors.text.primary};
    word-break: break-all;
    flex: 1;
  `,
  emptyHint: css`
    padding: ${theme.spacing(1)};
    color: ${theme.colors.text.secondary};
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
  `,
  eventRow: css`
    padding: ${theme.spacing(0.75)};
    border-bottom: 1px solid ${theme.colors.border.weak};
    &:last-child {
      border-bottom: none;
    }
  `,
  eventHeader: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    margin-bottom: ${theme.spacing(0.25)};
  `,
  eventName: css`
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  eventTs: css`
    margin-left: auto;
    color: ${theme.colors.text.secondary};
    font-size: 11px;
  `,
  exceptionIcon: css`
    color: ${theme.colors.error.text};
  `,
  stacktrace: css`
    margin: ${theme.spacing(0.5)} 0 0;
    padding: ${theme.spacing(1)};
    background: ${theme.colors.background.canvas};
    border-radius: ${theme.shape.radius.default};
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-all;
    color: ${theme.colors.error.text};
    max-height: 300px;
    overflow: auto;
  `,
  linkRow: css`
    padding: ${theme.spacing(0.75)};
    border-bottom: 1px solid ${theme.colors.border.weak};
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.25)};
    align-items: flex-start;
    &:last-child {
      border-bottom: none;
    }
  `,
  logLine: css`
    display: flex;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(0.25)} ${theme.spacing(0.5)};
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: 11px;
    border-bottom: 1px solid ${theme.colors.border.weak};
    &:last-child {
      border-bottom: none;
    }
  `,
  logTs: css`
    color: ${theme.colors.text.secondary};
    flex-shrink: 0;
  `,
  logSeverity: css`
    color: ${theme.colors.text.secondary};
    flex-shrink: 0;
    text-transform: uppercase;
  `,
  logBody: css`
    color: ${theme.colors.text.primary};
    white-space: pre-wrap;
    word-break: break-all;
  `,
});
