import React, { useRef } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, Icon, Tooltip } from '@grafana/ui';
import { WaterfallNode } from '../../sql/trace/tree';
import { serviceColor } from '../../constants';

interface TraceMinimapProps {
  nodes: WaterfallNode[];
  /** Current zoom window, both 0–1 fractions of the full trace. */
  zoomStart: number;
  zoomEnd: number;
  onZoomChange: (start: number, end: number) => void;
  onReset: () => void;
}

const HEIGHT = 34;

/**
 * Condensed timeline strip (Jaeger-style): every span rendered as a thin colored mark at its
 * offset/width, with a draggable brush overlay showing the current zoom window. Drag to select a
 * new sub-range; the brush position is written directly to the DOM during drag (not React state)
 * so dragging stays smooth even on traces with thousands of marks — same technique as
 * VolumeHistogram's drag-to-zoom.
 */
export function TraceMinimap({ nodes, zoomStart, zoomEnd, onZoomChange, onReset }: TraceMinimapProps) {
  const styles = useStyles2(getStyles);
  const trackRef = useRef<HTMLDivElement>(null);
  const brushRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<number | null>(null);

  const isZoomed = zoomStart > 0 || zoomEnd < 1;

  const pctFromEvent = (e: React.MouseEvent): number => {
    const el = trackRef.current;
    if (!el) {
      return 0;
    }
    const rect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    dragStart.current = pctFromEvent(e);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (dragStart.current === null || !brushRef.current) {
      return;
    }
    const cur = pctFromEvent(e);
    const x1 = Math.min(dragStart.current, cur);
    const x2 = Math.max(dragStart.current, cur);
    brushRef.current.style.left = `${x1 * 100}%`;
    brushRef.current.style.width = `${(x2 - x1) * 100}%`;
    brushRef.current.style.display = 'block';
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (dragStart.current === null) {
      return;
    }
    const end = pctFromEvent(e);
    const x1 = Math.min(dragStart.current, end);
    const x2 = Math.max(dragStart.current, end);
    dragStart.current = null;
    if (brushRef.current) {
      brushRef.current.style.display = 'none';
    }
    if (x2 - x1 < 0.01) {
      return; // treat as a stray click, not a zoom
    }
    onZoomChange(x1, x2);
  };

  return (
    <div className={styles.wrapper}>
      <div
        ref={trackRef}
        className={styles.track}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          dragStart.current = null;
          if (brushRef.current) {
            brushRef.current.style.display = 'none';
          }
        }}
      >
        {nodes.map((node) => (
          <div
            key={node.key}
            className={`${styles.mark} ${node.span.statusCode === 'STATUS_CODE_ERROR' ? styles.markError : ''}`}
            style={{
              left: `${node.startOffset * 100}%`,
              width: `${Math.max(node.widthFraction * 100, 0.2)}%`,
              top: `${2 + (node.depth % 8) * 3}px`,
              background: node.span.statusCode === 'STATUS_CODE_ERROR' ? undefined : serviceColor(node.span.serviceName),
            }}
          />
        ))}
        {/* Current zoom window, shown as a lighter overlay outside the selection */}
        <div className={styles.zoomShade} style={{ left: 0, width: `${zoomStart * 100}%` }} />
        <div className={styles.zoomShade} style={{ left: `${zoomEnd * 100}%`, width: `${(1 - zoomEnd) * 100}%` }} />
        <div ref={brushRef} className={styles.brush} style={{ display: 'none' }} />
      </div>
      {isZoomed && (
        <Tooltip content="Reset zoom">
          <button className={styles.resetBtn} onClick={onReset}>
            <Icon name="search-minus" size="sm" />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    padding: ${theme.spacing(0.5)} 0;
  `,
  track: css`
    position: relative;
    flex: 1;
    height: ${HEIGHT}px;
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    cursor: crosshair;
    overflow: hidden;
    user-select: none;
  `,
  mark: css`
    position: absolute;
    height: 2px;
    border-radius: 1px;
    min-width: 1px;
    pointer-events: none;
  `,
  markError: css`
    background: ${theme.colors.error.main};
  `,
  zoomShade: css`
    position: absolute;
    top: 0;
    bottom: 0;
    background: ${theme.colors.background.canvas};
    opacity: 0.6;
    pointer-events: none;
  `,
  brush: css`
    position: absolute;
    top: 0;
    bottom: 0;
    background: ${theme.colors.primary.transparent};
    border: 1px solid ${theme.colors.primary.border};
    pointer-events: none;
  `,
  resetBtn: css`
    background: transparent;
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    color: ${theme.colors.text.secondary};
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    width: ${HEIGHT}px;
    height: ${HEIGHT}px;
    flex-shrink: 0;
    &:hover {
      background: ${theme.colors.action.hover};
      color: ${theme.colors.text.primary};
    }
  `,
});
