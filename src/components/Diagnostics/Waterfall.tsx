/**
 * Renders one root span's tree as a waterfall — parallel siblings drawn at their true time
 * offsets (not stacked), per the diagnostics plan's Timeline tab. Bars are colored by phase kind
 * (see phaseColors.ts) so "was it ClickHouse or everything else" reads at a glance instead of
 * requiring every row's numbers to be read in turn; `status` still overrides for error/cancelled,
 * since those are more important facts than which phase a span represents.
 *
 * A time ruler above the bars and faint vertical gridlines through them give bar *position* actual
 * meaning — without them the bars are decoration a reader can't decode, which was the original
 * "looks bare" feedback this rewrite addresses. A still-live tree re-renders on a short interval so
 * its bars visibly grow instead of sitting static until the next real span mutation happens to
 * trigger one; see `hasRunningSpan`'s doc comment for why that's tree-wide, not just the root.
 */
import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2, useTheme2 } from '@grafana/ui';
import { Span, SpanStatus } from '../../diag/types';
import { formatDurationMs, spanDurationMs } from '../../diag/formatDuration';
import { useLiveNow } from '../../diag/useLiveNow';
import { hasRunningSpan, treeEndMs } from '../../diag/spanTree';
import { isPhaseKind, labelForKind, phaseColor, tooltipForKind } from './phaseColors';

interface WaterfallProps {
  root: Span;
}

/** A real measured span, or a placeholder standing in for a `transport`/`clickhouse` split that
 *  hasn't (or won't) arrive yet — see `pendingInfo`. Placeholders reserve their row's space
 *  immediately so the real bars fill *in place* once enrichment lands, rather than pushing the rows
 *  below them down the moment a `clickhouse` child is finally added (see `content-jumping`). */
type DisplayRow =
  | { kind: 'span'; key: string; span: Span; depth: number }
  | { kind: 'placeholder'; key: string; depth: number; phase: 'transport' | 'clickhouse'; parent: Span };

function buildDisplayRows(root: Span): DisplayRow[] {
  const rows: DisplayRow[] = [];
  function visit(span: Span, depth: number): void {
    rows.push({ kind: 'span', key: span.id, span, depth });
    for (const child of span.children) {
      visit(child, depth + 1);
    }
    if (typeof span.attrs.sql === 'string' && !span.children.some((c) => c.kind === 'clickhouse') && pendingInfo(root, span)) {
      rows.push({ kind: 'placeholder', key: `${span.id}-transport`, depth: depth + 1, phase: 'transport', parent: span });
      rows.push({ kind: 'placeholder', key: `${span.id}-clickhouse`, depth: depth + 1, phase: 'clickhouse', parent: span });
    }
  }
  visit(root, 0);
  return rows;
}

/**
 * A query span (has `attrs.sql`) with no `clickhouse` child yet isn't broken — server-side
 * enrichment (diag/autoEnrich.ts) only resolves 1-8s after the root ends, via a system.query_log
 * poll, and only if the toggle is on, and even then a fast poll round can match some of an action's
 * queries before others (see the B5 finding). Left unexplained, the absence reads as a bug rather
 * than a timing/config fact — this is the one place that decides what to say about it, reused by
 * both the row-building placeholder logic above and each placeholder row's own text.
 */
function pendingInfo(root: Span, span: Span): { text: string; pending: boolean } | null {
  if (typeof span.attrs.sql !== 'string' || span.children.some((c) => c.kind === 'clickhouse')) {
    return null;
  }
  switch (root.attrs.serverStatsStatus) {
    case 'not-tagged':
      return { text: 'server-side stats were off for this run', pending: false };
    case 'pending':
      return { text: 'waiting on ClickHouse query log…', pending: true };
    case 'no-data':
    case 'unavailable':
      return { text: 'server-side stats unavailable', pending: false };
    case 'ok':
      // The root as a whole got real data (some other query under it matched), but this
      // particular query span didn't — genuinely done polling, not still waiting.
      return { text: 'no server stats matched this query', pending: false };
    default:
      return null;
  }
}

const RULER_STOPS = [0, 0.25, 0.5, 0.75, 1] as const;

export function Waterfall({ root }: WaterfallProps) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const now = useLiveNow(hasRunningSpan(root));

  const endMs = treeEndMs(root) ?? now;
  const total = Math.max(endMs - root.startMs, 1); // guard against a 0ms tree dividing by zero
  const rows = buildDisplayRows(root);

  return (
    <div className={styles.container}>
      <div className={styles.ruler}>
        <div className={styles.rulerLabels}>
          {RULER_STOPS.map((stop) => (
            <span key={stop} className={styles.rulerTick} style={{ left: `${stop * 100}%` }}>
              {formatDurationMs(total * stop)}
            </span>
          ))}
        </div>
      </div>
      <div className={styles.rows}>
        {rows.map((row) => {
          if (row.kind === 'placeholder') {
            const info = pendingInfo(root, row.parent);
            const offsetPct = clampPct(((row.parent.startMs - root.startMs) / total) * 100);
            return (
              <div key={row.key} className={styles.row}>
                <div className={styles.label} style={{ paddingLeft: row.depth * 16 }}>
                  <TreeGuides depth={row.depth} styles={styles} />
                  <span className={styles.name}>{labelForKind(row.phase, row.phase)}</span>
                </div>
                <div className={styles.duration}>—</div>
                <div className={styles.barTrack}>
                  <div
                    className={info?.pending ? styles.placeholderPending : styles.placeholderDone}
                    style={{ left: `${offsetPct}%`, width: `${Math.max(100 - offsetPct, 4)}%` }}
                    title={info?.text}
                  />
                </div>
              </div>
            );
          }

          const { span, depth } = row;
          const duration = spanDurationMs(span.startMs, span.endMs, now);
          const pct = total > 0 ? Math.round((duration / total) * 100) : 0;
          const offsetPct = clampPct(((span.startMs - root.startMs) / total) * 100);
          const widthPct = clampPct((duration / total) * 100, 100 - offsetPct);
          const color = isPhaseKind(span.kind) ? phaseColor(theme, span.kind) : undefined;
          return (
            <div key={row.key} className={styles.row}>
              <div className={styles.label} style={{ paddingLeft: depth * 16 }}>
                <TreeGuides depth={depth} styles={styles} />
                {color && <span className={styles.swatch} style={{ background: color }} />}
                <span className={styles.name} title={tooltipForKind(span.kind, span.name)}>
                  {labelForKind(span.kind, span.name)}
                </span>
                {span.error && (
                  <Icon name="exclamation-triangle" size="xs" className={styles.errorIcon} title={span.error} />
                )}
              </div>
              <div className={styles.duration}>
                {formatDurationMs(duration)}
                {span.endMs != null && <span className={styles.durationPct}> {pct}%</span>}
              </div>
              <div className={styles.barTrack}>
                <div
                  className={cxStatus(styles, span.status)}
                  style={{
                    left: `${offsetPct}%`,
                    width: `${Math.max(widthPct, 0.5)}%`,
                    background: span.status === 'ok' && color ? color : undefined,
                  }}
                  title={`${labelForKind(span.kind, span.name)}: ${formatDurationMs(duration)}${span.error ? ` — ${span.error}` : ''}`}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 1px vertical rules at each indent level, Jaeger-style, so parent/child nesting is readable
 *  without counting pixels of left padding. */
function TreeGuides({ depth, styles }: { depth: number; styles: ReturnType<typeof getStyles> }) {
  if (depth === 0) {
    return null;
  }
  return (
    <span className={styles.guides} aria-hidden="true">
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} className={styles.guide} style={{ left: i * 16 + 7 }} />
      ))}
    </span>
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
      return styles.bar;
  }
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
  `,
  ruler: css`
    position: relative;
    height: 20px;
    margin-left: 136px; // aligns with the barTrack column below (label + duration columns' width)
    margin-bottom: ${theme.spacing(0.5)};
    border-bottom: 1px solid ${theme.colors.border.weak};
  `,
  rulerLabels: css`
    position: relative;
    height: 100%;
  `,
  rulerTick: css`
    position: absolute;
    bottom: 4px;
    transform: translateX(-50%);
    font-family: ${theme.typography.fontFamilyMonospace};
    font-variant-numeric: tabular-nums;
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.disabled};
    white-space: nowrap;
    &:first-of-type {
      transform: none;
    }
    &:last-of-type {
      transform: translateX(-100%);
    }
  `,
  rows: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.25)};
  `,
  row: css`
    display: grid;
    grid-template-columns: minmax(120px, 1fr) 64px minmax(120px, 2fr);
    align-items: center;
    gap: ${theme.spacing(1)};
    min-height: 28px;
  `,
  label: css`
    position: relative;
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    min-width: 0;
  `,
  guides: css`
    position: absolute;
    left: 0;
    top: -2px;
    bottom: -2px;
    width: 100%;
  `,
  guide: css`
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: ${theme.colors.border.weak};
  `,
  swatch: css`
    width: 8px;
    height: 8px;
    border-radius: 2px;
    flex-shrink: 0;
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
    white-space: nowrap;
  `,
  durationPct: css`
    color: ${theme.colors.text.disabled};
  `,
  barTrack: css`
    position: relative;
    height: 8px;
    background: ${theme.colors.background.secondary};
    border-radius: ${theme.shape.radius.default};
    background-image: repeating-linear-gradient(
      to right,
      ${theme.colors.border.weak} 0,
      ${theme.colors.border.weak} 1px,
      transparent 1px,
      transparent 25%
    );
  `,
  bar: css`
    position: absolute;
    top: 0;
    height: 100%;
    border-radius: ${theme.shape.radius.default};
    min-width: 2px;
    background: ${theme.colors.success.main};
  `,
  barRunning: css`
    background: ${theme.colors.info.main};
    animation: chobsPulse 1.2s ease-in-out infinite;
    @keyframes chobsPulse {
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
  placeholderPending: css`
    position: absolute;
    top: 0;
    height: 100%;
    border-radius: ${theme.shape.radius.default};
    background: linear-gradient(
      90deg,
      ${theme.colors.background.secondary} 25%,
      ${theme.colors.emphasize(theme.colors.background.secondary, 0.15)} 50%,
      ${theme.colors.background.secondary} 75%
    );
    background-size: 200% 100%;
    animation: chobsShimmer 1.4s ease-in-out infinite;
    @keyframes chobsShimmer {
      0% {
        background-position: 200% 0;
      }
      100% {
        background-position: -200% 0;
      }
    }
  `,
  placeholderDone: css`
    position: absolute;
    top: 0;
    height: 100%;
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
    border: 1px dashed ${theme.colors.border.weak};
  `,
});
