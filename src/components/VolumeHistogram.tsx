import React, { useMemo, useRef } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { VolumeDataPoint } from '../types';
import { SEVERITY_COLORS, SEVERITY_ORDER } from '../constants';

interface VolumeHistogramProps {
  data: VolumeDataPoint[];
  timeRange: TimeRange;
  height?: number;
  onSelectRange?: (from: number, to: number) => void;
}

/** Calculate bucket interval in seconds to target ~60 buckets over the time range. */
export function calcBucketInterval(timeRange: TimeRange): number {
  const spanMs = timeRange.to.valueOf() - timeRange.from.valueOf();
  const targetBuckets = 60;
  const rawSec = Math.ceil(spanMs / 1000 / targetBuckets);
  // Round to a nice step
  const steps = [10, 30, 60, 120, 300, 600, 1800, 3600, 7200, 21600, 86400];
  return steps.find((s) => s >= rawSec) ?? 86400;
}

export function VolumeHistogram({
  data,
  timeRange,
  height = 64,
  onSelectRange,
}: VolumeHistogramProps) {
  const styles = useStyles2(getStyles);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragStart = useRef<number | null>(null);
  const selectionRef = useRef<SVGRectElement | null>(null);

  const { bars, maxTotal, allLevels, totalCount } = useMemo(() => {
    if (!data.length) {
      return { bars: [], maxTotal: 0, allLevels: [], totalCount: 0 };
    }

    const levelSet = new Set<string>();
    let maxTotal = 0;
    let totalCount = 0;

    const bars = data.map((d) => {
      let bucketTotal = 0;
      for (const [level, count] of Object.entries(d.levels)) {
        levelSet.add(level.toLowerCase());
        bucketTotal += count;
        totalCount += count;
      }
      maxTotal = Math.max(maxTotal, bucketTotal);
      return d;
    });

    const allLevels = [
      ...SEVERITY_ORDER.filter((l) => levelSet.has(l)),
      ...[...levelSet].filter((l) => !SEVERITY_ORDER.includes(l)),
    ];

    return { bars, maxTotal, allLevels, totalCount };
  }, [data]);

  if (!data.length) {
    return null;
  }

  // Map SVG x% to a timestamp given the data array
  function xPctToTime(pct: number): number {
    if (!bars.length) {
      return timeRange.from.valueOf();
    }
    const idx = Math.floor((pct / 100) * bars.length);
    const clamped = Math.max(0, Math.min(bars.length - 1, idx));
    return bars[clamped].time * 1000; // bars[i].time is Unix seconds
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
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (dragStart.current === null || !svgRef.current) {
      return;
    }
    const cur = getSvgXPct(e);
    const x1 = Math.min(dragStart.current, cur);
    const x2 = Math.max(dragStart.current, cur);
    if (selectionRef.current) {
      selectionRef.current.setAttribute('x', `${x1}%`);
      selectionRef.current.setAttribute('width', `${x2 - x1}%`);
      selectionRef.current.setAttribute('display', 'block');
    }
  };

  const handleMouseUp = (e: React.MouseEvent<SVGSVGElement>) => {
    if (dragStart.current === null || !onSelectRange) {
      dragStart.current = null;
      return;
    }
    const end = getSvgXPct(e);
    const x1 = Math.min(dragStart.current, end);
    const x2 = Math.max(dragStart.current, end);
    dragStart.current = null;
    if (selectionRef.current) {
      selectionRef.current.setAttribute('display', 'none');
    }
    if (x2 - x1 < 0.5) {
      // Single click — zoom into bucket
      const t = xPctToTime(end);
      const halfBucketMs = calcBucketInterval(timeRange) * 500;
      onSelectRange(t - halfBucketMs, t + halfBucketMs);
    } else {
      onSelectRange(xPctToTime(x1), xPctToTime(x2));
    }
  };

  return (
    <div className={styles.wrapper}>
      <div className={styles.meta}>
        <span className={styles.totalCount}>{totalCount.toLocaleString()} events</span>
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
            if (selectionRef.current) {
              selectionRef.current.setAttribute('display', 'none');
            }
          }}
        >
          {bars.map((d, i) => {
            const x = (i / bars.length) * 100;
            const w = (1 / bars.length) * 100 - 0.15;
            let yOffset = height;

            return (
              <g key={d.time}>
                {allLevels.map((level) => {
                  const count = d.levels[level] ?? 0;
                  if (!count) {
                    return null;
                  }
                  const barH = maxTotal > 0 ? (count / maxTotal) * (height - 2) : 0;
                  yOffset -= barH;
                  const color = SEVERITY_COLORS[level] ?? SEVERITY_COLORS['unknown'];
                  return (
                    <rect
                      key={level}
                      x={`${x}%`}
                      y={yOffset}
                      width={`${w}%`}
                      height={barH}
                      fill={color}
                      opacity={0.85}
                    >
                      <title>{`${level}: ${count}`}</title>
                    </rect>
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
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
  `,
  meta: css`
    display: flex;
    align-items: center;
    padding: 0 2px;
  `,
  totalCount: css`
    font-size: 11px;
    color: ${theme.colors.text.secondary};
    font-variant-numeric: tabular-nums;
  `,
  container: css`
    width: 100%;
    border-bottom: 1px solid ${theme.colors.border.weak};
    background: ${theme.colors.background.canvas};
    margin-bottom: ${theme.spacing(0.5)};
  `,
  svg: css`
    display: block;
  `,
  svgZoomable: css`
    cursor: crosshair;
    user-select: none;
  `,
});
