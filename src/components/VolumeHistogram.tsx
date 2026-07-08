import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { css, cx } from '@emotion/css';
import { dateTime, formattedValueToString, getValueFormat, GrafanaTheme2, TimeRange } from '@grafana/data';
import { Button, Portal, useStyles2 } from '@grafana/ui';
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

/**
 * Zero-fill missing buckets across the full time range so gaps (e.g. no logs for a stretch of a
 * day query) render as flat-zero bars instead of vanishing, matching Kibana's histogram behavior.
 * Only safe for fixed-width units (second/minute/hour/day) — ClickHouse's toStartOfInterval anchors
 * these to the Unix epoch, so `floor(t / stepMs) * stepMs` reproduces the same bucket boundaries.
 * week/month/year use calendar-relative anchors instead, so those are left sparse rather than risk
 * misaligned filler bars.
 */
export function fillEmptyBuckets(
  points: VolumeDataPoint[],
  resolved: ResolvedInterval,
  timeRange: TimeRange
): VolumeDataPoint[] {
  if (resolved.unit === 'WEEK' || resolved.unit === 'MONTH' || resolved.unit === 'YEAR') {
    return points;
  }
  const stepMs = resolved.intervalMs;
  if (!stepMs || stepMs <= 0) {
    return points;
  }
  const byTime = new Map(points.map((p) => [p.time, p]));
  const start = Math.floor(timeRange.from.valueOf() / stepMs) * stepMs;
  const end = timeRange.to.valueOf();
  const filled: VolumeDataPoint[] = [];
  for (let t = start; t <= end; t += stepMs) {
    filled.push(byTime.get(t) ?? { time: t, levels: {} });
  }
  return filled;
}

// ─── Component ───────────────────────────────────────────────────────────────

/** Minimum rendered height (px) for any non-zero stacked segment — see the render loop below. */
const MIN_SEGMENT_PX = 2;

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
  /** Fired when the user picks "Filter for value" / "Filter out value" from the popup shown
   *  after clicking a breakdown segment directly — see BreakdownClickPopover below. Only ever
   *  reachable when colorMode === 'breakdown'. */
  onBreakdownFilter?: (value: string, op: '=' | '!=') => void;
}

interface HoveredBucket {
  index: number;
  clientX: number;
  clientY: number;
}

interface BreakdownClickPopover {
  level: string;
  clientX: number;
  clientY: number;
}

/** Compact large numbers (1,234,567 → "1.23 M") for the y-axis and tooltip, per Kibana's style. */
function formatCompact(n: number): string {
  return formattedValueToString(getValueFormat('short')(n));
}

/** Classic "nice number" rounding (Heckbert) — rounds to 1/2/5 × 10^n so axis ticks read like
 *  Kibana's (0/1/2, 0/5/10/15/20, …) instead of raw fractions of an arbitrary max. */
function niceNumber(value: number, round: boolean): number {
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / 10 ** exponent;
  let niceFraction: number;
  if (round) {
    niceFraction = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
  } else {
    niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  }
  return niceFraction * 10 ** exponent;
}

/** Evenly-spaced, round-number y-axis ticks from 0 up to a rounded max ≥ `max`. */
function niceYTicks(max: number, targetTicks = 5): number[] {
  if (max <= 0) {
    return [0];
  }
  // Counts are always integers, so a sub-1 step can only ever produce duplicate rounded ticks
  // (e.g. max=2 → step 0.5 → 0, 0.5, 1, 1.5, 2 all round to 0/1/1/2/2) — which then collide as
  // React keys below and corrupt the whole axis's rendering. Floor the step at 1.
  const step = Math.max(1, niceNumber(niceNumber(max, false) / (targetTicks - 1), true));
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= niceMax + step * 0.5; v += step) {
    ticks.push(Math.round(v));
  }
  // Belt-and-suspenders: dedupe in case of any other float-rounding collision.
  return [...new Set(ticks)];
}

export function VolumeHistogram({
  data,
  timeRange,
  height = 64,
  colorMode,
  bucketMs,
  onSelectRange,
  onBreakdownFilter,
}: VolumeHistogramProps) {
  const styles = useStyles2(getStyles);
  const svgRef = useRef<SVGSVGElement>(null);
  // Legend interaction (Kibana-style): click a series to isolate it (hide the rest); ctrl/cmd-
  // click to toggle just that one series without touching the others. Purely a client-side view
  // filter — doesn't affect the underlying query or the "N events" total shown elsewhere.
  const [hiddenLevels, setHiddenLevels] = useState<Set<string>>(new Set());
  const [breakdownPopover, setBreakdownPopover] = useState<BreakdownClickPopover | null>(null);
  // dragStart holds the live drag-anchor value used by the imperative mouse-move math below.
  // isDragging mirrors "is a drag in progress" into state so the render below (hover band
  // visibility) doesn't read a ref during render.
  const dragStart = useRef<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const selectionRef = useRef<SVGRectElement | null>(null);
  const [hovered, setHovered] = useState<HoveredBucket | null>(null);
  // Measured after each render so the tooltip can be clamped/flipped away from the right edge —
  // its content-driven width (level names, counts) isn't known until it's actually painted.
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [tooltipWidth, setTooltipWidth] = useState(0);

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

  const visibleLevels = useMemo(() => allLevels.filter((l) => !hiddenLevels.has(l)), [allLevels, hiddenLevels]);

  // Re-derive the stacked max against only the currently-visible series, so isolating/hiding a
  // series rescales the chart to the remaining data instead of leaving dead headroom.
  const visibleMaxTotal = useMemo(() => {
    if (hiddenLevels.size === 0) {
      return maxTotal;
    }
    let m = 0;
    for (const bar of bars) {
      let sum = 0;
      for (const level of visibleLevels) {
        const rawLevel = Object.keys(bar.levels).find((k) => k.toLowerCase() === level);
        if (rawLevel !== undefined) {
          sum += bar.levels[rawLevel];
        }
      }
      m = Math.max(m, sum);
    }
    return m;
  }, [bars, visibleLevels, hiddenLevels, maxTotal]);

  // Round-number y-axis (Kibana-style: 0/1/2, 0/5/10/15/20, …) instead of raw min/mid/max —
  // niceMax (the last tick) is what bar heights actually scale against, so bars and gridlines
  // always agree. Tick *count* is capped by how much vertical room there actually is. A label's
  // own line-height needs ~20px of clearance, not just its font-size, or adjacent ticks collide —
  // at our 32px default histogram height that means exactly 2 ticks (0 and max), not 3+.
  const maxTicksForHeight = Math.max(2, Math.min(5, Math.floor(height / 20)));
  const yTicks = useMemo(
    () => niceYTicks(visibleMaxTotal, maxTicksForHeight),
    [visibleMaxTotal, maxTicksForHeight]
  );
  const niceMax = yTicks[yTicks.length - 1] || 0;

  const onLegendClick = (level: string, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      setHiddenLevels((prev) => {
        const next = new Set(prev);
        if (next.has(level)) {
          next.delete(level);
        } else {
          next.add(level);
        }
        return next;
      });
      return;
    }
    setHiddenLevels((prev) => {
      // Already isolated to exactly this level → clicking again shows all.
      const isolatedToThis = prev.size === allLevels.length - 1 && !prev.has(level);
      return isolatedToThis ? new Set() : new Set(allLevels.filter((l) => l !== level));
    });
  };

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

  const hoveredBar = hovered !== null ? bars[hovered.index] : null;

  // Measures the tooltip's actual rendered width so the position calc below can flip it to the
  // left of the cursor when it would otherwise overflow the viewport's right edge. Must stay
  // above the early return below — hooks can't be called conditionally.
  useLayoutEffect(() => {
    if (tooltipRef.current) {
      setTooltipWidth(tooltipRef.current.offsetWidth);
    }
  }, [hoveredBar]);

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

  /** Percent across the chart's x-axis for a raw clientX — not tied to a React SVG event, so it
   *  can be reused by both the SVG's own handlers and the window-level listeners a drag attaches
   *  (see handleMouseDown) once the pointer has left the SVG's bounds. Deliberately NOT clamped
   *  to 0-100: dragging past either edge should still register as "select to the edge", which the
   *  x1/x2 min/max math below already handles regardless of sign or overshoot. */
  function getXPctFromClientX(clientX: number): number {
    const svg = svgRef.current;
    if (!svg) {
      return 0;
    }
    const rect = svg.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * 100;
  }

  function getSvgXPct(e: React.MouseEvent<SVGSVGElement>): number {
    return getXPctFromClientX(e.clientX);
  }

  function updateSelectionRect(cur: number) {
    if (dragStart.current === null) {
      return;
    }
    const x1 = Math.min(dragStart.current, cur);
    const x2 = Math.max(dragStart.current, cur);
    if (selectionRef.current) {
      selectionRef.current.setAttribute('x', `${x1}%`);
      selectionRef.current.setAttribute('width', `${x2 - x1}%`);
      selectionRef.current.setAttribute('display', 'block');
    }
  }

  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!onSelectRange) {
      return;
    }
    dragStart.current = getSvgXPct(e);
    setIsDragging(true);
    setHovered(null);

    // A drag that leaves the SVG's bounds (mouse dips below the chart, say) shouldn't cancel —
    // Kibana keeps tracking as long as the button is held, wherever the pointer wanders. Window-
    // level listeners (not the SVG's own onMouseMove/onMouseUp) are what make that possible.
    const onWindowMouseMove = (ev: MouseEvent) => {
      updateSelectionRect(getXPctFromClientX(ev.clientX));
    };
    const onWindowMouseUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onWindowMouseMove);
      window.removeEventListener('mouseup', onWindowMouseUp);
      finishDrag(ev.clientX, ev.clientY);
    };
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    // While dragging, the window-level listener attached in handleMouseDown owns the selection
    // rect — this handler only needs to run for hover, which is irrelevant during a drag anyway.
    if (dragStart.current !== null) {
      return;
    }
    const pct = getSvgXPct(e);

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

  /** Which stacked segment (level) a click landed on, reconstructing the same offsets the render
   *  loop below uses so the two never drift apart. */
  function pickLevelAtY(bar: VolumeDataPoint, clientY: number): string | null {
    const svg = svgRef.current;
    if (!svg) {
      return null;
    }
    const relY = clientY - svg.getBoundingClientRect().top;
    let yOffset = height;
    for (const level of visibleLevels) {
      const rawLevel = Object.keys(bar.levels).find((k) => k.toLowerCase() === level);
      const count = rawLevel !== undefined ? bar.levels[rawLevel] : 0;
      if (!count) {
        continue;
      }
      const rawH = niceMax > 0 ? (count / niceMax) * (height - 2) : 0;
      const barH = Math.max(rawH, MIN_SEGMENT_PX);
      yOffset -= barH;
      if (relY >= yOffset && relY <= yOffset + barH) {
        return level;
      }
    }
    return null;
  }

  /** Shared end-of-drag logic — called from the window-level mouseup listener attached in
   *  handleMouseDown, wherever the pointer ends up (inside or outside the SVG). */
  function finishDrag(clientX: number, clientY: number) {
    if (dragStart.current === null || !onSelectRange) {
      dragStart.current = null;
      setIsDragging(false);
      return;
    }
    const end = getXPctFromClientX(clientX);
    const x1 = Math.min(dragStart.current, end);
    const x2 = Math.max(dragStart.current, end);
    dragStart.current = null;
    setIsDragging(false);
    if (selectionRef.current) {
      selectionRef.current.setAttribute('display', 'none');
    }
    if (x2 - x1 < 0.5) {
      const t = xPctToTime(end);
      if (colorMode === 'breakdown' && onBreakdownFilter) {
        const idx = Math.max(0, Math.min(bars.length - 1, Math.floor((end / 100) * bars.length)));
        const level = bars[idx] ? pickLevelAtY(bars[idx], clientY) : null;
        if (level) {
          setHovered(null);
          setBreakdownPopover({ level, clientX, clientY });
          return;
        }
      }
      // Single click off any segment (or non-breakdown mode) — zoom into one bucket instead.
      const halfBucketMs = bucketMs / 2;
      onSelectRange(t - halfBucketMs, t + halfBucketMs);
    } else {
      onSelectRange(xPctToTime(x1), xPctToTime(x2));
    }
  }

  const hasLegend = (colorMode === 'breakdown' || colorMode === 'severity') && allLevels.length > 0;

  return (
    <div className={styles.wrapper}>
      <div className={styles.mainRow}>
      <div className={styles.chartCol}>
      {/* SVG bar chart, with a y-axis gutter to its left for scale reference */}
      <div className={styles.chartRow}>
        <div className={styles.yAxis} style={{ height }}>
          {[...yTicks].reverse().map((tick) => (
            <span key={tick} style={{ top: `${(1 - tick / niceMax) * 100}%` }}>
              {formatCompact(tick)}
            </span>
          ))}
        </div>
        <div className={styles.container} style={{ height }}>
        <svg
          ref={svgRef}
          width="100%"
          height={height}
          className={`${styles.svg} ${onSelectRange ? styles.svgZoomable : ''}`}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => {
            // Only clear hover state here — an active drag is tracked by the window-level
            // listeners from handleMouseDown regardless of whether the pointer is still over the
            // SVG, so leaving must NOT cancel it (see finishDrag / getXPctFromClientX).
            setHovered(null);
          }}
        >
          {/* One gridline per round-number y-axis tick, so bars visually line up with the scale
              they're actually plotted against (niceMax), not an arbitrary 3-line split. */}
          {yTicks.map((tick) => (
            <line
              key={tick}
              x1="0%"
              x2="100%"
              y1={niceMax > 0 ? height - (tick / niceMax) * height : height}
              y2={niceMax > 0 ? height - (tick / niceMax) * height : height}
              className={styles.gridline}
            />
          ))}

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
                {visibleLevels.map((level) => {
                  const rawLevel = Object.keys(d.levels).find((k) => k.toLowerCase() === level);
                  const count = rawLevel !== undefined ? d.levels[rawLevel] : 0;
                  if (!count) {
                    return null;
                  }
                  const rawH = niceMax > 0 ? (count / niceMax) * (height - 2) : 0;
                  // Any non-zero segment gets floored to MIN_SEGMENT_PX so a handful of errors
                  // stacked against tens of thousands of info logs still render as a visible
                  // sliver instead of rounding to a sub-pixel — and disappearing — segment.
                  // Stacking still works normally; this only ever grows the segment, never shrinks
                  // a larger one, so bars can slightly overshoot the top gridline in extreme
                  // imbalance cases — an acceptable tradeoff for "the error color is never invisible."
                  const barH = Math.max(rawH, MIN_SEGMENT_PX);
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
      </div>

      {/* Legend — severity mode and field-breakdown mode both benefit from it; 'single' has
          only one color so a legend would add nothing (color-not-only is still satisfied via
          the numeric tooltip, which never depends on color alone). Click a series to isolate it,
          ctrl/cmd-click to toggle just that one, Kibana-style. */}
      {hasLegend && (
        <div className={styles.legend}>
          {allLevels.map((level) => {
            const isHidden = hiddenLevels.has(level);
            return (
              <button
                key={level}
                className={cx(styles.legendItem, isHidden && styles.legendItemHidden)}
                onClick={(e) => onLegendClick(level, e)}
                title={isHidden ? 'Hidden — click to isolate, ctrl/cmd-click to show' : 'Click to isolate, ctrl/cmd-click to toggle'}
              >
                <span
                  className={styles.legendSwatch}
                  style={{ background: colorMap[level] ?? OTHER_COLOR }}
                />
                <span className={styles.legendLabel}>{level || '(empty)'}</span>
              </button>
            );
          })}
        </div>
      )}
      </div>

      {/* Hover tooltip */}
      {hoveredBar && hovered && (
        <div
          ref={tooltipRef}
          className={styles.tooltip}
          style={{
            position: 'fixed',
            // Default to the right of the cursor; flip to the left if it would overflow the
            // viewport's right edge (e.g. hovering buckets near the far-right of the chart).
            left:
              tooltipWidth && hovered.clientX + 14 + tooltipWidth > window.innerWidth
                ? Math.max(8, hovered.clientX - 14 - tooltipWidth)
                : hovered.clientX + 14,
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
            Total: {formatCompact(Object.values(hoveredBar.levels).reduce((a, b) => a + b, 0))}
          </div>
          {colorMode !== 'single' &&
            visibleLevels
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
                      {formatCompact(hoveredBar.levels[rawLevel])}
                    </span>
                  </div>
                );
              })}
        </div>
      )}

      {/* Breakdown-segment click popover — Kibana shows this instead of instantly applying a
          filter, so the user picks "for"/"out" rather than guessing what a bare click will do. */}
      {breakdownPopover && onBreakdownFilter && (
        <Portal>
          <div className={styles.popoverBackdrop} onClick={() => setBreakdownPopover(null)} />
          <div
            className={styles.popover}
            style={{ left: breakdownPopover.clientX, top: breakdownPopover.clientY }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.popoverTitle} title={breakdownPopover.level}>
              {breakdownPopover.level || '(empty)'}
            </div>
            <Button
              size="sm"
              variant="secondary"
              icon="filter"
              fill="text"
              onClick={() => {
                onBreakdownFilter(breakdownPopover.level, '=');
                setBreakdownPopover(null);
              }}
            >
              Filter for value
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon="ban"
              fill="text"
              onClick={() => {
                onBreakdownFilter(breakdownPopover.level, '!=');
                setBreakdownPopover(null);
              }}
            >
              Filter out value
            </Button>
          </div>
        </Portal>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  popoverBackdrop: css`
    position: fixed;
    inset: 0;
    z-index: 9999;
  `,
  popover: css`
    position: fixed;
    z-index: 10000;
    transform: translate(-50%, 8px);
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: ${theme.spacing(0.5)};
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    box-shadow: ${theme.shadows.z3};
    min-width: 180px;
  `,
  popoverTitle: css`
    padding: ${theme.spacing(0.5)} ${theme.spacing(0.5)} ${theme.spacing(0.25)};
    font-size: ${theme.typography.bodySmall.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 260px;
  `,
  wrapper: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
  `,
  mainRow: css`
    display: flex;
    align-items: stretch;
    gap: ${theme.spacing(1)};
  `,
  chartCol: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  `,
  chartRow: css`
    display: flex;
    align-items: stretch;
    gap: ${theme.spacing(0.5)};
  `,
  yAxis: css`
    position: relative;
    width: 36px;
    flex-shrink: 0;
    text-align: right;
    font-size: 12px;
    color: ${theme.colors.text.disabled};
    font-variant-numeric: tabular-nums;
    & > span {
      position: absolute;
      right: 0;
      transform: translateY(-50%);
      white-space: nowrap;
    }
    & > span:first-of-type {
      transform: translateY(0);
    }
    & > span:last-of-type {
      transform: translateY(-100%);
    }
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
    flex-direction: column;
    flex-shrink: 0;
    gap: 2px;
    max-width: 160px;
    max-height: 100px;
    overflow-y: auto;
    padding: 2px;
    border-left: 1px solid ${theme.colors.border.weak};
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
    font-size: 12px;
    color: ${theme.colors.text.disabled};
    font-variant-numeric: tabular-nums;
  `,
  legendItem: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 1px ${theme.spacing(0.5)};
    border-radius: ${theme.shape.radius.default};
    text-align: left;
    &:hover { background: ${theme.colors.action.hover}; }
  `,
  legendItemHidden: css`
    opacity: 0.4;
  `,
  legendSwatch: css`
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  `,
  legendLabel: css`
    font-size: 13px;
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
