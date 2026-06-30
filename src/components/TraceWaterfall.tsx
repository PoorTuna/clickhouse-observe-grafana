import React, { useMemo } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { SpanRow } from '../types';

interface WaterfallNode extends SpanRow {
  children: WaterfallNode[];
  depth: number;
  startOffset: number; // 0–1 relative to trace start
  widthFraction: number; // 0–1 relative to trace duration
}

interface TraceWaterfallProps {
  spans: SpanRow[];
}

function buildTree(spans: SpanRow[]): WaterfallNode[] {
  if (!spans.length) {
    return [];
  }

  const traceStart = Math.min(...spans.map((s) => s.startTime));
  const traceEnd = Math.max(...spans.map((s) => s.startTime + Math.max(s.durationNs / 1e6, 1)));
  const totalMs = Math.max(traceEnd - traceStart, 1);

  const byId = new Map<string, WaterfallNode>();
  for (const span of spans) {
    byId.set(span.spanID, {
      ...span,
      children: [],
      depth: 0,
      startOffset: (span.startTime - traceStart) / totalMs,
      widthFraction: Math.max(span.durationNs / 1e6, 0.5) / totalMs,
    });
  }

  const roots: WaterfallNode[] = [];
  for (const node of byId.values()) {
    const parent = byId.get(node.parentSpanID);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort children and roots by startTime so waterfall reads top-to-bottom chronologically
  const sortByStart = (nodes: WaterfallNode[]) => nodes.sort((a, b) => a.startTime - b.startTime);
  sortByStart(roots);
  for (const node of byId.values()) {
    sortByStart(node.children);
  }

  // Assign depths via BFS
  const queue = roots.map((r) => ({ node: r, depth: 0 }));
  while (queue.length) {
    const { node, depth } = queue.shift()!;
    node.depth = depth;
    for (const child of node.children) {
      queue.push({ node: child, depth: depth + 1 });
    }
  }

  const flat: WaterfallNode[] = [];
  const walk = (nodes: WaterfallNode[]) => {
    for (const n of nodes) {
      flat.push(n);
      walk(n.children);
    }
  };
  walk(roots);

  return flat;
}

const ROW_HEIGHT = 28;
const LABEL_WIDTH = 280;
const INDENT = 16;

function formatDuration(ns: number): string {
  if (ns >= 1e9) {
    return `${(ns / 1e9).toFixed(2)}s`;
  }
  if (ns >= 1e6) {
    return `${(ns / 1e6).toFixed(2)}ms`;
  }
  if (ns >= 1e3) {
    return `${(ns / 1e3).toFixed(2)}µs`;
  }
  return `${ns}ns`;
}

export function TraceWaterfall({ spans }: TraceWaterfallProps) {
  const styles = useStyles2(getStyles);
  const nodes = useMemo(() => buildTree(spans), [spans]);

  if (!spans.length) {
    return <div className={styles.empty}>No spans found.</div>;
  }

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.headerRow}>
        <div className={styles.labelCol}>Span</div>
        <div className={styles.barCol}>
          <div className={styles.barAxis}>
            <span>0</span>
            <span>25%</span>
            <span>50%</span>
            <span>75%</span>
            <span>100%</span>
          </div>
        </div>
      </div>

      {/* Rows */}
      <div className={styles.rows}>
        {nodes.map((node, i) => {
          const isError = node.statusCode === 'STATUS_CODE_ERROR';
          return (
            <div key={node.spanID} className={styles.row}>
              {/* Label */}
              <div
                className={styles.labelCol}
                style={{ paddingLeft: LABEL_WIDTH * 0 + node.depth * INDENT }}
              >
                <span
                  className={styles.serviceName}
                  title={node.serviceName}
                  style={{ marginLeft: node.depth * INDENT }}
                >
                  {node.serviceName || node.spanID.slice(0, 8)}
                </span>
                <span className={styles.opName} title={node.operationName}>
                  {node.operationName || node.spanID.slice(0, 12)}
                </span>
                {isError && <span className={styles.errorBadge}>ERR</span>}
              </div>

              {/* Bar */}
              <div className={styles.barCol}>
                <div className={styles.barTrack}>
                  {(() => {
                    const pct = Math.max(node.widthFraction * 100, 0.5);
                    const leftPct = node.startOffset * 100;
                    const tooNarrow = pct < 8;
                    const labelRight = leftPct + pct > 95;
                    return (
                      <>
                        <div
                          className={`${styles.bar} ${isError ? styles.barError : ''}`}
                          style={{ left: `${leftPct}%`, width: `${pct}%` }}
                          title={`${node.serviceName}: ${node.operationName} — ${formatDuration(node.durationNs)}`}
                        >
                          {!tooNarrow && (
                            <span className={styles.barLabel}>{formatDuration(node.durationNs)}</span>
                          )}
                        </div>
                        {tooNarrow && (
                          <span
                            className={styles.barLabelOutside}
                            style={{ left: labelRight ? `${leftPct - 1}%` : `${leftPct + pct + 0.5}%` }}
                          >
                            {formatDuration(node.durationNs)}
                          </span>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    overflow-x: auto;
  `,
  headerRow: css`
    display: flex;
    border-bottom: 1px solid ${theme.colors.border.medium};
    padding: ${theme.spacing(0.5)} 0;
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
    background: ${theme.colors.background.secondary};
    position: sticky;
    top: 0;
    z-index: 1;
  `,
  rows: css``,
  row: css`
    display: flex;
    align-items: center;
    border-bottom: 1px solid ${theme.colors.border.weak};
    height: ${ROW_HEIGHT}px;
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  labelCol: css`
    width: ${LABEL_WIDTH}px;
    min-width: ${LABEL_WIDTH}px;
    padding: 0 ${theme.spacing(1)};
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    overflow: hidden;
  `,
  barCol: css`
    flex: 1;
    padding: 0 ${theme.spacing(1)};
  `,
  barAxis: css`
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: ${theme.colors.text.disabled};
    padding: 0 ${theme.spacing(0.5)};
  `,
  barTrack: css`
    position: relative;
    height: 16px;
    background: ${theme.colors.background.secondary};
    border-radius: 2px;
  `,
  bar: css`
    position: absolute;
    top: 2px;
    height: 12px;
    background: ${theme.colors.primary.main};
    border-radius: 2px;
    display: flex;
    align-items: center;
    min-width: 2px;
    overflow: hidden;
  `,
  barError: css`
    background: ${theme.colors.error.main};
  `,
  barLabel: css`
    font-size: 10px;
    color: ${theme.colors.primary.contrastText};
    white-space: nowrap;
    padding: 0 3px;
    overflow: hidden;
  `,
  barLabelOutside: css`
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    font-size: 10px;
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
  `,
  serviceName: css`
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 80px;
  `,
  opName: css`
    color: ${theme.colors.text.primary};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  `,
  errorBadge: css`
    background: ${theme.colors.error.main};
    color: ${theme.colors.error.contrastText};
    font-size: 10px;
    padding: 1px 4px;
    border-radius: 2px;
    flex-shrink: 0;
  `,
  empty: css`
    padding: ${theme.spacing(4)};
    text-align: center;
    color: ${theme.colors.text.secondary};
  `,
});
