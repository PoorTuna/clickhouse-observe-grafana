/**
 * Renders one root span's tree as a waterfall — parallel siblings drawn at their true time
 * offsets (not stacked), per the diagnostics plan's Timeline tab. Bar color encodes status; a
 * still-`running` root re-renders on a short interval so its bars visibly grow instead of sitting
 * static until the next real span mutation happens to trigger one.
 */
import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';
import { Span, SpanStatus } from '../../diag/types';
import { formatDurationMs, spanDurationMs } from '../../diag/formatDuration';
import { useLiveNow } from '../../diag/useLiveNow';
import { flattenSpanTree } from '../../diag/spanTree';

interface WaterfallProps {
  root: Span;
}

export function Waterfall({ root }: WaterfallProps) {
  const styles = useStyles2(getStyles);
  // Only ticks while the selected root has live work — an ended root (the common case, since most
  // opens happen after the fact) never re-renders on a timer. See useLiveNow's doc comment for why
  // this reads performance.now() inside an effect rather than during render.
  const now = useLiveNow(root.status === 'running');

  const rootEnd = root.endMs ?? now;
  const total = Math.max(rootEnd - root.startMs, 1); // guard against a 0ms root dividing by zero
  const rows = flattenSpanTree(root);

  return (
    <div className={styles.container}>
      {rows.map(({ span, depth }) => {
        const duration = spanDurationMs(span.startMs, span.endMs, now);
        const offsetPct = clampPct(((span.startMs - root.startMs) / total) * 100);
        const widthPct = clampPct((duration / total) * 100, 100 - offsetPct);
        return (
          <div key={span.id} className={styles.row}>
            <div className={styles.label} style={{ paddingLeft: depth * 16 }}>
              <span className={styles.name} title={span.name}>
                {span.name}
              </span>
              {span.error && (
                <Icon name="exclamation-triangle" size="xs" className={styles.errorIcon} title={span.error} />
              )}
            </div>
            <div className={styles.duration}>{formatDurationMs(duration)}</div>
            <div className={styles.barTrack}>
              <div
                className={cxStatus(styles, span.status)}
                style={{ left: `${offsetPct}%`, width: `${Math.max(widthPct, 0.5)}%` }}
                title={`${span.name}: ${formatDurationMs(duration)}${span.error ? ` — ${span.error}` : ''}`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function clampPct(value: number, max = 100): number {
  return Math.min(Math.max(value, 0), max);
}

function cxStatus(styles: ReturnType<typeof getStyles>, status: SpanStatus): string {
  switch (status) {
    case 'running':
      return `${styles.bar} ${styles.barRunning}`;
    case 'error':
      return `${styles.bar} ${styles.barError}`;
    case 'cancelled':
      return `${styles.bar} ${styles.barCancelled}`;
    default:
      return `${styles.bar} ${styles.barOk}`;
  }
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.25)};
  `,
  row: css`
    display: grid;
    grid-template-columns: minmax(120px, 1fr) 64px minmax(120px, 2fr);
    align-items: center;
    gap: ${theme.spacing(1)};
    min-height: 24px;
  `,
  label: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    min-width: 0;
  `,
  name: css`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.primary};
  `,
  errorIcon: css`
    color: ${theme.colors.error.text};
    flex-shrink: 0;
  `,
  duration: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    font-variant-numeric: tabular-nums;
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    text-align: right;
  `,
  barTrack: css`
    position: relative;
    height: 8px;
    background: ${theme.colors.background.secondary};
    border-radius: ${theme.shape.radius.default};
  `,
  bar: css`
    position: absolute;
    top: 0;
    height: 100%;
    border-radius: ${theme.shape.radius.default};
    min-width: 2px;
  `,
  barOk: css`
    background: ${theme.colors.success.main};
  `,
  barRunning: css`
    background: ${theme.colors.info.main};
    animation: pulse 1.2s ease-in-out infinite;
    @keyframes pulse {
      0%,
      100% {
        opacity: 0.6;
      }
      50% {
        opacity: 1;
      }
    }
  `,
  barError: css`
    background: ${theme.colors.error.main};
  `,
  barCancelled: css`
    background: ${theme.colors.text.disabled};
  `,
});
