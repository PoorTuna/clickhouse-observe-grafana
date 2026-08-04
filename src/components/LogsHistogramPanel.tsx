/**
 * Volume-histogram panel for LogsExplorer's results pane: interval/breakdown pickers, the chart
 * itself (or an empty/loading placeholder), and the "N documents / interval: X" meta line.
 * Split out of LogsExplorer.tsx purely to keep that page's file size down — no behavior change,
 * same props the inline block already closed over. Renders nothing when `hasTime` is false (no
 * timestamp column mapped — same gate the inline block used at its call site).
 */
import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
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
}: LogsHistogramPanelProps) {
  const styles = useStyles2(getStyles);

  if (!hasTime) {
    return null;
  }

  return (
    <div className={styles.histogramPanel}>
      <div className={styles.histogramHeader}>
        <IntervalPicker value={intervalMode} onChange={onIntervalModeChange} timeRange={timeRange} />
        <BreakdownPicker value={breakdown} onChange={onBreakdownChange} hasSeverity={hasSeverity} />
        <div className={styles.histogramHeaderSpacer} />
        {volumeData.length > 0 && (
          <span className={styles.histogramMeta}>
            {totalEvents.toLocaleString()} documents (count) &middot; interval: {resolvedInterval.label}
          </span>
        )}
      </div>
      {volumeData.length > 0 ? (
        <VolumeHistogram
          data={volumeData}
          timeRange={timeRange}
          height={110}
          loading={volLoading}
          onSelectRange={onSelectRange}
          onBreakdownFilter={onBreakdownFilter}
          colorMode={colorModeFor(breakdown)}
          bucketMs={resolvedInterval.intervalMs}
        />
      ) : (
        <div className={styles.histogramEmpty}>{volLoading ? 'Loading…' : 'No events in selected time range'}</div>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  histogramPanel: css`
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
  `,
  histogramEmpty: css`
    height: 32px;
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
    padding: ${theme.spacing(0.75)} ${theme.spacing(1)};
    border-bottom: 1px solid ${theme.colors.border.weak};
  `,
  histogramHeaderSpacer: css`
    flex: 1;
  `,
  histogramMeta: css`
    font-size: 13px;
    color: ${theme.colors.text.disabled};
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  `,
});
