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
import { useStyles2 } from '@grafana/ui';
import { Span } from '../../diag/types';
import { querySpans } from '../../diag/spanTree';
import { isEnrichmentEnabled } from '../../diag/enrichment';
import { DiagEmptyState } from './DiagEmptyState';
import { formatBytes, formatCount } from './formatNumbers';
import { labelForKind } from './phaseColors';

interface StatsTableProps {
  root: Span;
}

/** `result_rows / read_rows` as a percentage — a low ratio is the schema-pk-filter-on-orderby
 *  diagnosis made visible: the query read far more rows than it returned, which usually means its
 *  filters aren't hitting the table's sort key. `undefined` when either number is missing/zero, so
 *  a 0% row never gets manufactured out of absent data. */
function readEfficiency(span: { attrs: Record<string, unknown> }): number | undefined {
  const read = span.attrs.serverReadRows;
  const result = span.attrs.serverResultRows;
  if (typeof read !== 'number' || typeof result !== 'number' || read <= 0) {
    return undefined;
  }
  return (result / read) * 100;
}

export function StatsTable({ root }: StatsTableProps) {
  const styles = useStyles2(getStyles);

  if (!isEnrichmentEnabled()) {
    return (
      <DiagEmptyState
        icon="info-circle"
        title="Server-side stats are off"
        description="Enable them below to see ClickHouse execution details for future actions."
      />
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
      <DiagEmptyState
        icon="info-circle"
        title="This action's queries were never tagged"
        description="It ran before server-side stats were turned on, so nothing will arrive for it. Enable the toggle below and run the action again."
      />
    );
  }

  if (status === 'pending') {
    return (
      <DiagEmptyState
        icon="hourglass"
        title="Waiting for ClickHouse's query log to flush"
        description="This can take a few seconds."
      />
    );
  }

  if (status === 'no-data') {
    return (
      <DiagEmptyState
        icon="info-circle"
        title="No matching rows showed up in system.query_log"
        description="Possible causes: the log hasn't flushed yet (its default flush interval is 7.5s), log_queries is disabled for this user, or the table's retention is shorter than the lookup window."
      />
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
      <DiagEmptyState
        icon="exclamation-triangle"
        tone="warning"
        title={message}
        description={detail}
      />
    );
  }

  const spans = querySpans(root).filter((span) => typeof span.attrs.serverDurationMs === 'number');
  if (spans.length === 0) {
    return (
      <DiagEmptyState icon="info-circle" title="No queries in this action matched yet" />
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
            <th>Efficiency</th>
            <th>Memory</th>
            <th>Marks</th>
            <th>Parts</th>
          </tr>
        </thead>
        <tbody>
          {spans.map((span, i) => {
            const efficiency = readEfficiency(span);
            return (
              <tr key={span.id} className={i % 2 === 1 ? styles.zebra : undefined}>
                <td>{labelForKind(span.kind, span.name)}</td>
                <td className={styles.num}>{formatCount(span.attrs.serverDurationMs)} ms</td>
                <td className={styles.num}>{formatCount(span.attrs.serverReadRows)}</td>
                <td className={styles.num}>{formatBytes(span.attrs.serverReadBytes)}</td>
                <td className={styles.num}>{formatCount(span.attrs.serverResultRows)}</td>
                <td className={`${styles.num} ${efficiency != null && efficiency < 1 ? styles.efficiencyLow : ''}`}>
                  {efficiency != null ? `${efficiency < 0.1 ? '<0.1' : efficiency.toFixed(1)}%` : '—'}
                </td>
                <td className={styles.num}>{formatBytes(span.attrs.serverMemoryUsage)}</td>
                <td className={styles.num}>{formatCount(span.attrs.serverSelectedMarks)}</td>
                <td className={styles.num}>{formatCount(span.attrs.serverSelectedParts)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
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

    tbody tr:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  num: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    font-variant-numeric: tabular-nums;
    text-align: right;
  `,
  zebra: css`
    background: ${theme.colors.background.secondary};
  `,
  efficiencyLow: css`
    color: ${theme.colors.warning.text};
  `,
});
