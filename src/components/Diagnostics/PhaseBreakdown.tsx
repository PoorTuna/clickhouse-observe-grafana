/**
 * "Where the time went" — one stacked bar summing every phase span's duration across the whole
 * tree by kind (diag/types.ts's SpanKind), sitting between the summary card and the waterfall on
 * the Timeline tab. This is the highest-value addition of the visual overhaul: it answers the
 * feature's founding question ("was it ClickHouse or everything else?") in one glance instead of
 * requiring every waterfall row's numbers to be read and summed by hand.
 *
 * Concurrent queries (a search submit fans out logs+volume+presence together, by design — see the
 * diagnostics plan's Context section) mean these segments can sum to more than the action's own
 * wall-clock duration; this is deliberately a "where did the CPU-time-equivalent go" breakdown, not
 * a second waterfall, so it's normalized to the sum of the segments themselves, not to the root's
 * total duration.
 */
import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, useTheme2 } from '@grafana/ui';
import { Span } from '../../diag/types';
import { flattenSpanTree } from '../../diag/spanTree';
import { formatDurationMs } from '../../diag/formatDuration';
import { isPhaseKind, PHASE_KINDS, phaseColor, PHASE_SHORT_LABELS, PhaseKind } from './phaseColors';

interface PhaseBreakdownProps {
  root: Span;
}

function sumPhaseDurations(root: Span): Partial<Record<PhaseKind, number>> {
  const totals: Partial<Record<PhaseKind, number>> = {};
  for (const { span } of flattenSpanTree(root)) {
    if (span.endMs == null || !isPhaseKind(span.kind)) {
      continue;
    }
    totals[span.kind] = (totals[span.kind] ?? 0) + (span.endMs - span.startMs);
  }
  return totals;
}

export function PhaseBreakdown({ root }: PhaseBreakdownProps) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const totals = sumPhaseDurations(root);
  const grandTotal = PHASE_KINDS.reduce((sum, kind) => sum + (totals[kind] ?? 0), 0);

  if (grandTotal <= 0) {
    return null; // nothing measured yet — the waterfall below still shows the raw spans as they arrive
  }

  const present = PHASE_KINDS.filter((kind) => (totals[kind] ?? 0) > 0);
  const hasServerSplit = (totals.clickhouse ?? 0) > 0 || (totals.transport ?? 0) > 0;

  return (
    <div className={styles.container}>
      <div className={styles.heading}>Where the time went</div>
      <div className={styles.bar}>
        {present.map((kind) => (
          <div
            key={kind}
            className={styles.segment}
            style={{ width: `${((totals[kind] ?? 0) / grandTotal) * 100}%`, background: phaseColor(theme, kind) }}
            title={`${PHASE_SHORT_LABELS[kind]}: ${formatDurationMs(totals[kind] ?? 0)}`}
          />
        ))}
      </div>
      <div className={styles.legend}>
        {present.map((kind) => (
          <span key={kind} className={styles.legendItem}>
            <span className={styles.swatch} style={{ background: phaseColor(theme, kind) }} />
            {PHASE_SHORT_LABELS[kind]} {formatDurationMs(totals[kind] ?? 0)} ·{' '}
            {Math.round(((totals[kind] ?? 0) / grandTotal) * 100)}%
          </span>
        ))}
      </div>
      {!hasServerSplit && (
        <div className={styles.hint}>Turn on Server-side stats below to split ClickHouse execution from network time.</div>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    margin-bottom: ${theme.spacing(2)};
  `,
  heading: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    margin-bottom: ${theme.spacing(0.5)};
  `,
  bar: css`
    display: flex;
    height: 20px;
    border-radius: ${theme.shape.radius.default};
    overflow: hidden;
    background: ${theme.colors.background.secondary};
  `,
  segment: css`
    height: 100%;
    min-width: 2px;
  `,
  legend: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${theme.spacing(0.5)} ${theme.spacing(2)};
    margin-top: ${theme.spacing(0.75)};
  `,
  legendItem: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    font-family: ${theme.typography.fontFamilyMonospace};
    font-variant-numeric: tabular-nums;
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  swatch: css`
    width: 8px;
    height: 8px;
    border-radius: 2px;
    flex-shrink: 0;
  `,
  hint: css`
    margin-top: ${theme.spacing(0.75)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.disabled};
  `,
});
