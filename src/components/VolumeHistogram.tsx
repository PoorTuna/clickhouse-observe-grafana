import React, { useMemo, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { dateTime, GrafanaTheme2, TimeRange } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { VolumeDataPoint, IntervalMode } from '../types';
import { CHIntervalUnit } from '../sql/queryBuilder';
import {
  SEVERITY_COLORS,
  SEVERITY_ORDER,
  BREAKDOWN_PALETTE,
  OTHER_COLOR,
  SINGLE_STACK_COLOR,
} from '../constants';

// ─── Interval helpers ────────────────────────────────────────────────────────

const UNIT_SECONDS: Record<Exclude<IntervalMode, 'auto'>, number> = {
  second: 1,
  minute: 60,
  hour:   3_600,
  day:    86_400,
  week:   604_800,
  month:  2_592_000,  // 30 days
  year:   31_536_000, // 365 days
};

const UNIT_CH: Record<Exclude<IntervalMode, 'auto'>, CHIntervalUnit> = {
  second: 'SECOND',
  minute: 'MINUTE',
  hour:   'HOUR',
  day:    'DAY',
  week:   'WEEK',
  month:  'MONTH',
  year:   'YEAR',
};

export interface ResolvedInterval {
  unit: CHIntervalUnit;
  value: number;
  /** Human-readable label, e.g. "Auto - 30 seconds" or "Minute". */
  label: string;
  /** Bucket width in milliseconds (used for single-click zoom). */
  intervalMs: number;
}

function formatDuration(sec: number): string {
  if (sec < 60)    {return `${sec} second${sec !== 1 ? 's' : ''}`;}
  if (sec < 3_600) {return `${sec / 60} minute${sec / 60 !== 1 ? 's' : ''}`;}
  if (sec < 86_400) {return `${sec / 3_600} hour${sec / 3_600 !== 1 ? 's' : ''}`;}
  return `${sec / 86_400} day${sec / 86_400 !== 1 ? 's' : ''}`;
}

/** Calculate bucket interval in seconds to target ~60 buckets over the time range. */
export function calcBucketInterval(timeRange: TimeRange): number {
  const spanMs = timeRange.to.valueOf() - timeRange.from.valueOf();
  const targetBuckets = 60;
  const rawSec = Math.ceil(spanMs / 1000 / targetBuckets);
  const steps = [10, 30, 60, 120, 300, 600, 1800, 3600, 7200, 21600, 86400];
  return steps.find((s) => s >= rawSec) ?? 86400;
}

/** Resolve an IntervalMode + time range into concrete SQL interval + display label. */
export function resolveInterval(mode: IntervalMode, timeRange: TimeRange): ResolvedInterval {
  if (mode === 'auto') {
    const sec = calcBucketInterval(timeRange);
    return { unit: 'SECOND', value: sec, label: `Auto - ${formatDuration(sec)}`, intervalMs: sec * 1000 };
  }
  const sec = UNIT_SECONDS[mode];
  const label = mode.charAt(0).toUpperCase() + mode.slice(1);
  return { unit: UNIT_CH[mode], value: 1, label, intervalMs: sec * 1000 };
}

/** Estimate how many bars a given mode would produce. Used to guard against too-fine intervals. */
export function estimateBucketCount(mode: IntervalMode, timeRange: TimeRange): number {
  const spanMs = timeRange.to.valueOf() - timeRange.from.valueOf();
  const sec = mode === 'auto' ? calcBucketInterval(timeRange) : UNIT_SECONDS[mode];
  return Math.ceil(spanMs / 1000 / sec);
}

// ─── Component ───────────────────────────────────────────────────────────────

export type HistogramColorMode = 'single' | 'severity' | 'breakdown';

interface VolumeHistogramProps {
  data: VolumeDataPoint[];
  timeRange: TimeRange;
  height?: number;
  /**
   * Controls how bars are colored:
   * - 'single'    → one accent color, no legend (No breakdown selected).
   * - 'severity'  → SEVERITY_COLORS ordered by SEVERITY_ORDER, no legend (default).
   * - 'breakdown' → categorical palette + legend (field breakdown active).
   */
  colorMode: HistogramColorMode;
  /** Bucket width in ms — drives single-click zoom width. */
  bucketMs: number;
  onSelectRange?: (from: number, to: number) => void;
}

interface HoveredBucket {
  index: number;
  clientX: number;
  clientY: number;
}

export function VolumeHistogram({
  data,
  timeRange,
  height = 64,
  colorMode,
  bucketMs,
  onSelectRange,
}: VolumeHistogramProps) {
  const styles = useStyles2(getStyles);
  const svgRef = useRef<SVGSVGElement>(null);
  // dragStart holds the live drag-anchor value used by the imperative mouse-move math below.
  // isDragging mirrors "is a drag in progress" into state so the render below (hover band
  // visibility) doesn't read a ref during render.
  const dragStart = useRef<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const selectionRef = useRef<SVGRectElement | null>(null);
  const [hovered, setHovered] = useState<HoveredBucket | null>(null);

  const { bars, maxTotal, allLevels, colorMap } = useMemo(() => {
    if (!data.length) {
      return { bars: [], maxTotal: 0, allLevels: [] as string[], totalCount: 0, colorMap: {} as Record<string, string> };
    }

    const levelSet = new Set<string>();
    let maxTotal = 0;
    let totalCount = 0;
    const levelTotals: Record<string, number> = {};

    const bars = data.map((d) => {
      let bucketTotal = 0;
      for (const [level, count] of Object.entries(d.levels)) {
        const key = level.toLowerCase();
        levelSet.add(key);
        bucketTotal += count;
        totalCount += count;
        levelTotals[key] = (levelTotals[key] ?? 0) + count;
      }
      maxTotal = Math.max(maxTotal, bucketTotal);
      return d;
    });

    let allLevels: string[];
    let colorMap: Record<string, string>;

    if (colorMode === 'breakdown') {
      // Categorical coloring: sort by total count desc, 'other' always last.
      const otherKey = 'other';
      const seriesKeys = [...levelSet].filter((l) => l !== otherKey);
      seriesKeys.sort((a, b) => (levelTotals[b] ?? 0) - (levelTotals[a] ?? 0));
      if (levelSet.has(otherKey)) {
        seriesKeys.push(otherKey);
      }
      allLevels = seriesKeys;
      colorMap = {};
      let paletteIdx = 0;
      for (const key of allLevels) {
        if (key === otherKey) {
          colorMap[key] = OTHER_COLOR;
        } else {
          colorMap[key] = BREAKDOWN_PALETTE[paletteIdx % BREAKDOWN_PALETTE.length];
          paletteIdx++;
        }
      }
    } else if (colorMode === 'severity') {
      // Severity stacking ordered by SEVERITY_ORDER.
      allLevels = [
        ...SEVERITY_ORDER.filter((l) => levelSet.has(l)),
        ...[...levelSet].filter((l) => !SEVERITY_ORDER.includes(l)),
      ];
      colorMap = Object.fromEntries(
        allLevels.map((l) => [l, SEVERITY_COLORS[l] ?? SEVERITY_COLORS['unknown']])
      );
    } else {
      // Single-stack ('none'): one accent color, no legend.
      allLevels = [...levelSet];
      colorMap = Object.fromEntries(allLevels.map((l) => [l, SINGLE_STACK_COLOR]));
    }

    return { bars, maxTotal, allLevels, totalCount, colorMap };
  }, [data, colorMode]);

  // A handful of evenly-spaced x-axis tick labels (first/last/quartiles) so the chart reads as a
  // real timeline instead of two bare endpoint labels. Computed before the early return below so
  // hook order stays stable across renders.
  const xTicks = useMemo(() => {
    if (bars.length === 0) {
      return [];
    }
    const n = bars.length;
    const idxs = Array.from(new Set([0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1]));
    return idxs.map((i) => ({ time: bars[i].time, label: dateTime(bars[i].time).format('MMM D, HH:mm') }));
  }, [bars]);

  if (!data.length) {
    return null;
  }

  function xPctToTime(pct: number): number {
    if (!bars.length) {
      return timeRange.from.valueOf();
    }
    const idx = Math.floor((pct / 100) * bars.length);
    const clamped = Math.max(0, Math.min(bars.length - 1, idx));
    return bars[clamped].time;
  }

  function getSvgXPct(e: React.MouseEvent<SVGSVGElement>): number {
    const svg = svgRef.current;
    if (!svg) {
      return 0;
    }
    const rect = svg.getBoundingClientRect();
    return ((e.clientX - rect.left) / rect.width) * 100;
  }

  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!onSelectRange) {
      return;
    }
    dragStart.current = getSvgXPct(e);
    setIsDragging(true);
    setHovered(null);
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const pct = getSvgXPct(e);

    if (dragStart.current !== null) {
      const cur = pct;
      const x1 = Math.min(dragStart.current, cur);
      const x2 = Math.max(dragStart.current, cur);
      if (selectionRef.current) {
        selectionRef.current.setAttribute('x', `${x1}%`);
        selectionRef.current.setAttribute('width', `${x2 - x1}%`);
        selectionRef.current.setAttribute('display', 'block');
      }
      return;
    }

    if (bars.length > 0) {
      const idx = Math.max(0, Math.min(bars.length - 1, Math.floor((pct / 100) * bars.length)));
      setHovered((prev) => {
        if (prev?.index === idx && prev.clientX === e.clientX && prev.clientY === e.clientY) {
          return prev;
        }
        return { index: idx, clientX: e.clientX, clientY: e.clientY };
      });
    }
  };

  const handleMouseUp = (e: React.MouseEvent<SVGSVGElement>) => {
    if (dragStart.current === null || !onSelectRange) {
      dragStart.current = null;
      setIsDragging(false);
      return;
    }
    const end = getSvgXPct(e);
    const x1 = Math.min(dragStart.current, end);
    const x2 = Math.max(dragStart.current, end);
    dragStart.current = null;
    setIsDragging(false);
    if (selectionRef.current) {
      selectionRef.current.setAttribute('display', 'none');
    }
    if (x2 - x1 < 0.5) {
      // Single click — zoom into one bucket using the resolved interval width.
      const t = xPctToTime(end);
      const halfBucketMs = bucketMs / 2;
      onSelectRange(t - halfBucketMs, t + halfBucketMs);
    } else {
      onSelectRange(xPctToTime(x1), xPctToTime(x2));
    }
  };

  const hoveredBar = hovered !== null ? bars[hovered.index] : null;

  const yMid = Math.round(maxTotal / 2);

  return (
    <div className={styles.wrapper}>
      {/* SVG bar chart, with a y-axis gutter to its left for scale reference */}
      <div className={styles.chartRow}>
        <div className={styles.yAxis} style={{ height }}>
          <span>{maxTotal.toLocaleString()}</span>
          <span>{yMid.toLocaleString()}</span>
          <span>0</span>
        </div>
        <div className={styles.container} style={{ height }}>
        <svg
          ref={svgRef}
          width="100%"
          height={height}
          className={`${styles.svg} ${onSelectRange ? styles.svgZoomable : ''}`}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            dragStart.current = null;
            setIsDragging(false);
            if (selectionRef.current) {
              selectionRef.current.setAttribute('display', 'none');
            }
            setHovered(null);
          }}
        >
          {/* Horizontal gridlines at 0 / 50% / 100% — reference points for reading bar magnitude */}
          <line x1="0%" x2="100%" y1={0} y2={0} className={styles.gridline} />
          <line x1="0%" x2="100%" y1={height / 2} y2={height / 2} className={styles.gridline} />
          <line x1="0%" x2="100%" y1={height - 1} y2={height - 1} className={styles.gridline} />

          {/* Hover highlight band — sits behind bars, hidden during drag */}
          {hovered !== null && !isDragging && (
            <rect
              x={`${(hovered.index / bars.length) * 100}%`}
              y={0}
              width={`${(1 / bars.length) * 100}%`}
              height={height}
              className={styles.highlightBand}
              style={{ pointerEvents: 'none' }}
            />
          )}

          {bars.map((d, i) => {
            const x = (i / bars.length) * 100;
            const w = (1 / bars.length) * 100 - 0.15;
            let yOffset = height;

            return (
              <g key={d.time}>
                {allLevels.map((level) => {
                  const rawLevel = Object.keys(d.levels).find((k) => k.toLowerCase() === level);
                  const count = rawLevel !== undefined ? d.levels[rawLevel] : 0;
                  if (!count) {
                    return null;
                  }
                  const barH = maxTotal > 0 ? (count / maxTotal) * (height - 2) : 0;
                  yOffset -= barH;
                  const color = colorMap[level] ?? OTHER_COLOR;
                  return (
                    <rect
                      key={level}
                      x={`${x}%`}
                      y={yOffset}
                      width={`${w}%`}
                      height={barH}
                      fill={color}
                      opacity={1}
                    />
                  );
                })}
              </g>
            );
          })}
          {/* Selection overlay */}
          <rect
            ref={selectionRef}
            x="0%"
            y={0}
            width="0%"
            height={height}
            fill="rgba(255,255,255,0.15)"
            stroke="rgba(255,255,255,0.5)"
            strokeWidth={1}
            display="none"
            style={{ pointerEvents: 'none' }}
          />
        </svg>
        </div>
      </div>

      {/* Legend — severity mode and field-breakdown mode both benefit from it; 'single' has
          only one color so a legend would add nothing (color-not-only is still satisfied via
          the numeric tooltip, which never depends on color alone). */}
      {(colorMode === 'breakdown' || colorMode === 'severity') && allLevels.length > 0 && (
        <div className={styles.legend}>
          {allLevels.map((level) => (
            <div key={level} className={styles.legendItem}>
              <span
                className={styles.legendSwatch}
                style={{ background: colorMap[level] ?? OTHER_COLOR }}
              />
              <span className={styles.legendLabel}>{level || '(empty)'}</span>
            </div>
          ))}
        </div>
      )}

      {/* x-axis ticks — evenly spaced reference points across the selected time range, offset by
          the same gutter width as the y-axis so they stay aligned under the bars. */}
      <div className={styles.axisRow}>
        <div className={styles.yAxisSpacer} />
        <div className={styles.axis}>
          {xTicks.map((tick) => (
            <span key={tick.time}>{tick.label}</span>
          ))}
        </div>
      </div>

      {/* Hover tooltip */}
      {hoveredBar && hovered && (
        <div
          className={styles.tooltip}
          style={{
            position: 'fixed',
            left: hovered.clientX + 14,
            // Clamp so the tooltip never gets clipped off the top of the viewport.
            top: Math.max(8, hovered.clientY - 80),
            zIndex: 1000,
            pointerEvents: 'none',
          }}
        >
          <div className={styles.tooltipTime}>
            {dateTime(hoveredBar.time).format('MMM D, YYYY HH:mm:ss')}
          </div>
          <div className={styles.tooltipTotal}>
            Total:{' '}
            {Object.values(hoveredBar.levels)
              .reduce((a, b) => a + b, 0)
              .toLocaleString()}
          </div>
          {colorMode !== 'single' &&
            allLevels
              .filter((level) => {
                const rawLevel = Object.keys(hoveredBar.levels).find((k) => k.toLowerCase() === level);
                return rawLevel !== undefined && hoveredBar.levels[rawLevel] > 0;
              })
              .map((level) => {
                const rawLevel = Object.keys(hoveredBar.levels).find((k) => k.toLowerCase() === level)!;
                return (
                  <div key={level} className={styles.tooltipRow}>
                    <span
                      className={styles.tooltipSwatch}
                      style={{ background: colorMap[level] ?? OTHER_COLOR }}
                    />
                    <span className={styles.tooltipLevel}>{level || '(empty)'}</span>
                    <span className={styles.tooltipCount}>
                      {hoveredBar.levels[rawLevel].toLocaleString()}
                    </span>
                  </div>
                );
              })}
        </div>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
  `,
  chartRow: css`
    display: flex;
    align-items: stretch;
    gap: ${theme.spacing(0.5)};
  `,
  yAxis: css`
    width: 34px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    text-align: right;
    font-size: 10px;
    color: ${theme.colors.text.disabled};
    font-variant-numeric: tabular-nums;
    padding: 1px 0;
  `,
  yAxisSpacer: css`
    width: 34px;
    flex-shrink: 0;
  `,
  container: css`
    width: 100%;
    flex: 1;
    min-width: 0;
  `,
  svg: css`
    display: block;
  `,
  gridline: css`
    stroke: ${theme.colors.border.weak};
    stroke-width: 1;
    shape-rendering: crispEdges;
  `,
  highlightBand: css`
    fill: ${theme.colors.action.hover};
  `,
  svgZoomable: css`
    cursor: crosshair;
    user-select: none;
  `,
  legend: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${theme.spacing(0.5)} ${theme.spacing(1.5)};
    padding: 0 2px ${theme.spacing(0.5)};
  `,
  axisRow: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
  `,
  axis: css`
    display: flex;
    justify-content: space-between;
    flex: 1;
    min-width: 0;
    padding: 0 2px;
    font-size: 10px;
    color: ${theme.colors.text.disabled};
    font-variant-numeric: tabular-nums;
  `,
  legendItem: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
  `,
  legendSwatch: css`
    width: 8px;
    height: 8px;
    border-radius: 2px;
    flex-shrink: 0;
  `,
  legendLabel: css`
    font-size: 11px;
    color: ${theme.colors.text.secondary};
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  tooltip: css`
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    box-shadow: ${theme.shadows.z2};
    padding: ${theme.spacing(1)};
    min-width: 160px;
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  tooltipTime: css`
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
    margin-bottom: ${theme.spacing(0.5)};
    white-space: nowrap;
  `,
  tooltipTotal: css`
    color: ${theme.colors.text.secondary};
    margin-bottom: ${theme.spacing(0.25)};
    font-variant-numeric: tabular-nums;
  `,
  tooltipRow: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    padding: 1px 0;
  `,
  tooltipSwatch: css`
    width: 8px;
    height: 8px;
    border-radius: 2px;
    flex-shrink: 0;
  `,
  tooltipLevel: css`
    flex: 1;
    color: ${theme.colors.text.primary};
    text-transform: capitalize;
  `,
  tooltipCount: css`
    color: ${theme.colors.text.secondary};
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  `,
});
