import React, { useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { SpanRow } from '../../types';
import { buildServiceGraph, ServiceGraphNode } from '../../sql/trace/serviceGraph';
import { serviceColor } from '../../constants';
import { formatMs } from '../../utils/traceFormat';

interface ServiceMapProps {
  spans: SpanRow[];
}

const SIZE = 520;
const CENTER = SIZE / 2;
const RADIUS = SIZE / 2 - 90;
const MIN_NODE_R = 16;
const MAX_NODE_R = 40;

/**
 * Per-trace service graph. Small graphs (typically a handful of services per trace) don't need a
 * force/layered layout algorithm — a circular layout places every node with guaranteed no overlap
 * and reads clearly regardless of edge topology, so that's what this renders.
 */
export function ServiceMap({ spans }: ServiceMapProps) {
  const styles = useStyles2(getStyles);
  const [selected, setSelected] = useState<string | null>(null);
  const { nodes, edges } = useMemo(() => buildServiceGraph(spans), [spans]);

  const maxCall = Math.max(1, ...nodes.map((n) => n.callCount));
  const positions = useMemo(() => {
    const map = new Map<string, { x: number; y: number; r: number }>();
    const n = nodes.length;
    nodes.forEach((node, i) => {
      const angle = (i / Math.max(n, 1)) * 2 * Math.PI - Math.PI / 2;
      const r = MIN_NODE_R + (Math.sqrt(node.callCount / maxCall) || 0) * (MAX_NODE_R - MIN_NODE_R);
      map.set(node.id, {
        x: CENTER + (n === 1 ? 0 : RADIUS * Math.cos(angle)),
        y: CENTER + (n === 1 ? 0 : RADIUS * Math.sin(angle)),
        r,
      });
    });
    return map;
  }, [nodes, maxCall]);

  if (nodes.length === 0) {
    return <div className={styles.empty}>No service data for this trace.</div>;
  }

  const selectedNode: ServiceGraphNode | undefined = nodes.find((n) => n.id === selected);

  return (
    <div className={styles.container}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className={styles.svg}>
        <defs>
          <marker id="sm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
          </marker>
        </defs>
        {edges.map((edge) => {
          const src = positions.get(edge.source);
          const dst = positions.get(edge.target);
          if (!src || !dst) {
            return null;
          }
          const dx = dst.x - src.x;
          const dy = dst.y - src.y;
          const dist = Math.max(Math.hypot(dx, dy), 1);
          // When the reverse edge also exists (A→B and B→A), offset each line perpendicular to
          // its direction so the two don't render as a single overlapping segment with only one
          // visible arrowhead — sign keyed off source<target so the pair offsets in opposite
          // directions consistently regardless of which one happens to render first.
          const hasReverse = edges.some((e) => e.source === edge.target && e.target === edge.source);
          const perpSign = edge.source < edge.target ? 1 : -1;
          const offset = hasReverse ? (perpSign * 6) : 0;
          const nx = (-dy / dist) * offset;
          const ny = (dx / dist) * offset;
          // Shorten the line so the arrowhead lands on the target node's edge, not its center.
          const x2 = dst.x + nx - (dx / dist) * (dst.r + 8);
          const y2 = dst.y + ny - (dy / dist) * (dst.r + 8);
          const x1 = src.x + nx + (dx / dist) * (src.r + 2);
          const y1 = src.y + ny + (dy / dist) * (src.r + 2);
          const thickness = 1 + Math.log2(edge.callCount + 1);
          return (
            <g key={edge.id} className={edge.errorRate > 0 ? styles.edgeError : styles.edge}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={thickness} markerEnd="url(#sm-arrow)" />
              <title>
                {edge.source} → {edge.target}: {edge.callCount} calls, {edge.errorCount} errors, avg{' '}
                {formatMs(edge.avgDurationMs)}
              </title>
            </g>
          );
        })}
        {nodes.map((node) => {
          const pos = positions.get(node.id)!;
          const color = serviceColor(node.id);
          return (
            <g
              key={node.id}
              className={styles.node}
              onClick={() => setSelected((s) => (s === node.id ? null : node.id))}
            >
              <circle
                cx={pos.x}
                cy={pos.y}
                r={pos.r}
                fill={color}
                stroke={selected === node.id ? '#fff' : 'transparent'}
                strokeWidth={2}
                opacity={0.9}
              />
              {node.errorCount > 0 && (
                <circle cx={pos.x + pos.r * 0.7} cy={pos.y - pos.r * 0.7} r={6} className={styles.errorDot} />
              )}
              <text x={pos.x} y={pos.y + pos.r + 14} textAnchor="middle" className={styles.label}>
                {node.id}
              </text>
              <title>
                {node.id}: {node.callCount} calls, {node.errorCount} errors, avg {formatMs(node.avgDurationMs)}, max{' '}
                {formatMs(node.maxDurationMs)}
              </title>
            </g>
          );
        })}
      </svg>
      {selectedNode && (
        <div className={styles.detailPanel}>
          <div className={styles.detailTitle}>
            <span className={styles.serviceDot} style={{ background: serviceColor(selectedNode.id) }} />
            {selectedNode.id}
          </div>
          <div className={styles.detailRow}>
            <span>Calls</span>
            <span>{selectedNode.callCount}</span>
          </div>
          <div className={styles.detailRow}>
            <span>Errors</span>
            <span>
              {selectedNode.errorCount} ({(selectedNode.errorRate * 100).toFixed(1)}%)
            </span>
          </div>
          <div className={styles.detailRow}>
            <span>Avg duration</span>
            <span>{formatMs(selectedNode.avgDurationMs)}</span>
          </div>
          <div className={styles.detailRow}>
            <span>Max duration</span>
            <span>{formatMs(selectedNode.maxDurationMs)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    align-items: flex-start;
    justify-content: center;
    gap: ${theme.spacing(2)};
    padding: ${theme.spacing(2)};
    height: 100%;
    overflow: auto;
  `,
  svg: css`
    width: 100%;
    max-width: ${SIZE}px;
    height: auto;
    flex-shrink: 0;
  `,
  node: css`
    cursor: pointer;
    &:hover circle:first-of-type {
      opacity: 1;
    }
  `,
  errorDot: css`
    fill: ${theme.colors.error.main};
    stroke: ${theme.colors.background.primary};
    stroke-width: 1.5px;
  `,
  label: css`
    fill: ${theme.colors.text.primary};
    font-size: 11px;
    font-family: ${theme.typography.fontFamily};
  `,
  edge: css`
    color: ${theme.colors.border.strong};
    line {
      stroke: currentColor;
      opacity: 0.6;
    }
  `,
  edgeError: css`
    color: ${theme.colors.error.main};
    line {
      stroke: currentColor;
      opacity: 0.8;
    }
  `,
  detailPanel: css`
    width: 220px;
    flex-shrink: 0;
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
    padding: ${theme.spacing(1.5)};
    position: sticky;
    top: ${theme.spacing(2)};
  `,
  detailTitle: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    font-weight: ${theme.typography.fontWeightMedium};
    margin-bottom: ${theme.spacing(1)};
  `,
  serviceDot: css`
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  `,
  detailRow: css`
    display: flex;
    justify-content: space-between;
    padding: ${theme.spacing(0.25)} 0;
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    span:last-child {
      color: ${theme.colors.text.primary};
    }
  `,
  empty: css`
    padding: ${theme.spacing(4)};
    text-align: center;
    color: ${theme.colors.text.secondary};
  `,
});
