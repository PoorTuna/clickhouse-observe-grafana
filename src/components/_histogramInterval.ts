/**
 * Histogram bucket-interval math — pure, no React. Split out of VolumeHistogram.tsx so this logic
 * (and its edge cases: auto-sizing to ~60 buckets, week/month/year's calendar-relative anchors not
 * being zero-fillable) is testable without mounting the chart component, and so the component file
 * carries only rendering/interaction code.
 */
import { TimeRange } from '@grafana/data';
import { VolumeDataPoint, IntervalMode } from '../types';
import { CHIntervalUnit } from '../sql/queryBuilder';

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
 * day query) render as flat-zero bars instead of vanishing.
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
  // Strictly less than `end`, not <=: when the range span divides evenly by stepMs (the common
  // case — e.g. a round "last 1 hour"), `t <= end` adds a spurious trailing bucket exactly at the
  // range's end instant. Its window is [end, end+stepMs), but the SQL query only includes events
  // up to the single instant `end` — so that bucket is structurally near-empty regardless of real
  // data, not a genuine gap. The bucket that actually contains `end` (start < end) is still
  // included, so the true last bucket never gets dropped.
  for (let t = start; t < end; t += stepMs) {
    filled.push(byTime.get(t) ?? { time: t, levels: {} });
  }
  return filled;
}
