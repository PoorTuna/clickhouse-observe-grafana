import React, { useMemo } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { VolumeDataPoint } from '../types';
import { SEVERITY_COLORS, SEVERITY_ORDER } from '../constants';

interface VolumeHistogramProps {
  data: VolumeDataPoint[];
  height?: number;
}

/** Severity-stacked bar chart for log volume over time. */
export function VolumeHistogram({ data, height = 60 }: VolumeHistogramProps) {
  const styles = useStyles2(getStyles);

  const { bars, maxTotal, allLevels } = useMemo(() => {
    if (!data.length) {
      return { bars: [], maxTotal: 0, allLevels: [] };
    }

    const levelSet = new Set<string>();
    let maxTotal = 0;
    const bars = data.map((d) => {
      let total = 0;
      for (const [level, count] of Object.entries(d.levels)) {
        levelSet.add(level.toLowerCase());
        total += count;
      }
      maxTotal = Math.max(maxTotal, total);
      return d;
    });

    // Order levels by severity for consistent stacking
    const allLevels = SEVERITY_ORDER.filter((l) => levelSet.has(l));
    const remaining = [...levelSet].filter((l) => !SEVERITY_ORDER.includes(l));

    return { bars, maxTotal, allLevels: [...allLevels, ...remaining] };
  }, [data]);

  if (!data.length) {
    return null;
  }

  return (
    <div className={styles.container} style={{ height }}>
      <svg width="100%" height={height} className={styles.svg}>
        {bars.map((d, i) => {
          const x = (i / bars.length) * 100;
          const w = (1 / bars.length) * 100 - 0.2;
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
      </svg>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    width: 100%;
    border-bottom: 1px solid ${theme.colors.border.weak};
    background: ${theme.colors.background.canvas};
    margin-bottom: ${theme.spacing(0.5)};
  `,
  svg: css`
    display: block;
  `,
});
