/**
 * Stats tab — real ClickHouse execution numbers per query (diagnostics plan Phase 2), read off the
 * `server*` attrs diag/autoEnrich.ts attaches once its system.query_log lookup lands. Empty states
 * here are deliberately specific: "no grant", "readonly", and "nothing arrived yet" are different
 * facts (see diag/serverStats.ts's ServerStatsResult), and this is the one surface whose entire
 * job is telling them apart instead of collapsing them into one generic "unavailable" message.
 */
import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';
import { Span } from '../../diag/types';
import { querySpans } from '../../diag/spanTree';
import { isEnrichmentEnabled } from '../../diag/enrichment';

interface StatsTableProps {
  root: Span;
}

function formatCount(n: unknown): string {
  return typeof n === 'number' ? n.toLocaleString() : '—';
}

function formatBytes(n: unknown): string {
  if (typeof n !== 'number') {
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function StatsTable({ root }: StatsTableProps) {
  const styles = useStyles2(getStyles);

  if (!isEnrichmentEnabled()) {
    return (
      <div className={styles.empty}>
        <Icon name="info-circle" size="lg" />
        <div>Server-side stats are off. Enable them below to see ClickHouse execution details for future actions.</div>
      </div>
    );
  }

  const status = root.attrs.serverStatsStatus;

  // 'not-tagged' (see diag/autoEnrich.ts) means enrichment was off for this root's entire
  // lifetime — its queries never carried a log_comment, so no lookup will ever find them, even
  // after turning the toggle on. `status == null` is the same fact for a root that ended before
  // this distinction existed (or, defensively, any other path that skipped stamping it) — treated
  // identically rather than falling into the "pending" message below, which would be a permanent,
  // misleading "still waiting" for something that was never attempted.
  if (status == null || status === 'not-tagged') {
    return (
      <div className={styles.empty}>
        <Icon name="info-circle" size="lg" />
        <div>
          This action ran before server-side stats were turned on, so its queries were never tagged — nothing will
          arrive for it. Enable the toggle below and run the action again.
        </div>
      </div>
    );
  }

  if (status === 'pending') {
    return (
      <div className={styles.empty}>
        <Icon name="hourglass" size="lg" />
        <div>Waiting for ClickHouse&apos;s query log to flush — this can take a few seconds.</div>
      </div>
    );
  }

  if (status === 'no-data') {
    return (
      <div className={styles.empty}>
        <Icon name="info-circle" size="lg" />
        <div>
          No matching rows showed up in <code>system.query_log</code>. Possible causes: the log hasn&apos;t flushed yet
          (its default flush interval is 7.5s), <code>log_queries</code> is disabled for this user, or the table&apos;s
          retention is shorter than the lookup window.
        </div>
      </div>
    );
  }

  if (status === 'unavailable') {
    const reason = root.attrs.serverStatsReason;
    const detail = typeof root.attrs.serverStatsDetail === 'string' ? root.attrs.serverStatsDetail : undefined;
    const message =
      reason === 'no-grant'
        ? "This ClickHouse user doesn't have SELECT on system.query_log — ask an admin to grant it, or leave server-side stats off."
        : reason === 'readonly'
          ? 'This ClickHouse user is in readonly mode, which also blocks the SETTINGS tag diagnostics needs to correlate queries.'
          : 'The stats lookup itself failed.';
    return (
      <div className={styles.empty}>
        <Icon name="exclamation-triangle" size="lg" className={styles.warnIcon} />
        <div>{message}</div>
        {detail && <div className={styles.detail}>{detail}</div>}
      </div>
    );
  }

  const spans = querySpans(root).filter((span) => typeof span.attrs.serverDurationMs === 'number');
  if (spans.length === 0) {
    return (
      <div className={styles.empty}>
        <Icon name="info-circle" size="lg" />
        <div>No queries in this action matched yet.</div>
      </div>
    );
  }

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Query</th>
            <th>Duration</th>
            <th>Rows read</th>
            <th>Bytes read</th>
            <th>Result rows</th>
            <th>Memory</th>
            <th>Marks</th>
            <th>Parts</th>
          </tr>
        </thead>
        <tbody>
          {spans.map((span) => (
            <tr key={span.id}>
              <td>{span.name}</td>
              <td className={styles.num}>{formatCount(span.attrs.serverDurationMs)} ms</td>
              <td className={styles.num}>{formatCount(span.attrs.serverReadRows)}</td>
              <td className={styles.num}>{formatBytes(span.attrs.serverReadBytes)}</td>
              <td className={styles.num}>{formatCount(span.attrs.serverResultRows)}</td>
              <td className={styles.num}>{formatBytes(span.attrs.serverMemoryUsage)}</td>
              <td className={styles.num}>{formatCount(span.attrs.serverSelectedMarks)}</td>
              <td className={styles.num}>{formatCount(span.attrs.serverSelectedParts)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  empty: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: ${theme.spacing(1)};
    color: ${theme.colors.text.secondary};
    padding: ${theme.spacing(4)} ${theme.spacing(2)};
    text-align: center;
    max-width: 480px;
    margin: 0 auto;
  `,
  warnIcon: css`
    color: ${theme.colors.warning.text};
  `,
  detail: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.disabled};
  `,
  tableWrap: css`
    overflow-x: auto;
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;
    font-size: ${theme.typography.bodySmall.fontSize};

    th,
    td {
      text-align: left;
      padding: ${theme.spacing(0.75)} ${theme.spacing(1)};
      border-bottom: 1px solid ${theme.colors.border.weak};
      white-space: nowrap;
    }

    th {
      color: ${theme.colors.text.secondary};
      font-weight: ${theme.typography.fontWeightMedium};
    }
  `,
  num: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    font-variant-numeric: tabular-nums;
    text-align: right;
  `,
});
