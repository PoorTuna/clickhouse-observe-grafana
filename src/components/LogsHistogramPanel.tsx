/**
 * Volume-histogram panel for LogsExplorer's results pane: interval/breakdown pickers, the chart
 * itself (or an empty/loading placeholder), and the "N rows / interval: X" meta line.
 * Split out of LogsExplorer.tsx purely to keep that page's file size down — no behavior change,
 * same props the inline block already closed over. Renders nothing when `hasTime` is false (no
 * timestamp column mapped — same gate the inline block used at its call site).
 *
 * Panel is framed with a top/bottom rule (not a boxed card), generously padded, with the meta
 * caption centered under the chart rather than crammed into the toolbar row.
 */
import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { IconButton, useStyles2 } from '@grafana/ui';
import { BreakdownSel, IntervalMode, VolumeDataPoint } from '../types';
import { VolumeHistogram, ResolvedInterval, HistogramColorMode } from './VolumeHistogram';
import { IntervalPicker } from './HistogramControls/IntervalPicker';
import { BreakdownPicker } from './HistogramControls/BreakdownPicker';

interface LogsHistogramPanelProps {
  hasTime: boolean;
  hasSeverity: boolean;
  intervalMode: IntervalMode;
  onIntervalModeChange: (mode: IntervalMode) => void;
  timeRange: TimeRange;
  breakdown: BreakdownSel;
  onBreakdownChange: (b: BreakdownSel) => void;
  volumeData: VolumeDataPoint[];
  volLoading: boolean;
  totalEvents: number;
  resolvedInterval: ResolvedInterval;
  onSelectRange: (fromMs: number, toMs: number) => void;
  onBreakdownFilter: (value: string, op: '=' | '!=') => void;
  /** Collapses the chart down to just the toolbar row (interval/breakdown pickers stay reachable)
   *  without unmounting them, so the query state they hold isn't lost while collapsed. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

function colorModeFor(breakdown: BreakdownSel): HistogramColorMode {
  if (breakdown.kind === 'field') {
    return 'breakdown';
  }
  if (breakdown.kind === 'severity') {
    return 'severity';
  }
  return 'single';
}

export function LogsHistogramPanel({
  hasTime,
  hasSeverity,
  intervalMode,
  onIntervalModeChange,
  timeRange,
  breakdown,
  onBreakdownChange,
  volumeData,
  volLoading,
  totalEvents,
  resolvedInterval,
  onSelectRange,
  onBreakdownFilter,
  collapsed,
  onToggleCollapsed,
}: LogsHistogramPanelProps) {
  const styles = useStyles2(getStyles);

  if (!hasTime) {
    return null;
  }

  return (
    <div className={styles.histogramPanel}>
      <div className={styles.histogramHeader}>
        <IconButton
          name={collapsed ? 'angle-down' : 'angle-up'}
          size="sm"
          tooltip={collapsed ? 'Show histogram' : 'Hide histogram'}
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        />
        <IntervalPicker value={intervalMode} onChange={onIntervalModeChange} timeRange={timeRange} />
        <BreakdownPicker value={breakdown} onChange={onBreakdownChange} hasSeverity={hasSeverity} />
      </div>
      {!collapsed &&
        (volumeData.length > 0 ? (
          <>
            <VolumeHistogram
              data={volumeData}
              timeRange={timeRange}
              height={120}
              loading={volLoading}
              onSelectRange={onSelectRange}
              onBreakdownFilter={onBreakdownFilter}
              colorMode={colorModeFor(breakdown)}
              bucketMs={resolvedInterval.intervalMs}
            />
            <span className={styles.histogramMeta}>
              {totalEvents.toLocaleString()} rows (count) &middot; interval: {resolvedInterval.label}
            </span>
          </>
        ) : (
          <div className={styles.histogramEmpty}>{volLoading ? 'Loading…' : 'No events in selected time range'}</div>
        ))}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  histogramPanel: css`
    display: flex;
    flex-direction: column;
    padding: ${theme.spacing(1)};
    border-top: 1px solid ${theme.colors.border.weak};
    border-bottom: 1px solid ${theme.colors.border.weak};
  `,
  histogramEmpty: css`
    height: 120px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: ${theme.colors.text.disabled};
    font-size: ${theme.typography.body.fontSize};
  `,
  histogramHeader: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    padding-bottom: ${theme.spacing(1)};
  `,
  histogramMeta: css`
    font-size: 12px;
    line-height: 16px;
    text-align: center;
    padding: 0 ${theme.spacing(1)};
    color: ${theme.colors.text.secondary};
    font-variant-numeric: tabular-nums;
  `,
});
