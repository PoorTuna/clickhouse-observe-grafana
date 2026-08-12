/**
 * Unit tests for _histogramInterval.ts — pure bucket-interval math extracted out of
 * VolumeHistogram.tsx (see that file's re-exports). Had no dedicated coverage before this split;
 * covers the auto-sizing step table, the fixed-vs-calendar-relative unit distinction that gates
 * fillEmptyBuckets, and the off-by-one at a range's trailing edge fillEmptyBuckets deliberately
 * avoids (see its doc comment).
 */
import { dateTime, TimeRange } from '@grafana/data';
import {
  calcBucketInterval,
  resolveInterval,
  estimateBucketCount,
  fillEmptyBuckets,
  ResolvedInterval,
} from '../_histogramInterval';
import { VolumeDataPoint } from '../../types';

function range(fromMs: number, toMs: number): TimeRange {
  return {
    from: dateTime(fromMs),
    to: dateTime(toMs),
    raw: { from: dateTime(fromMs), to: dateTime(toMs) },
  };
}

describe('calcBucketInterval', () => {
  it('picks the smallest step whose bucket count is <= ~60 for a 1-hour range', () => {
    const r = range(0, 3_600_000); // 1 hour
    // 3600s / 60 buckets = 60s/bucket target -> first step >= 60 is 60.
    expect(calcBucketInterval(r)).toBe(60);
  });

  it('picks a coarser-than-a-day step for a 1-year range instead of hairline-thin daily bars', () => {
    const r = range(0, 365 * 86_400_000); // 1 year
    // 365d / 60 buckets ≈ 6.08d/bucket target -> first step >= that is 10 days.
    expect(calcBucketInterval(r)).toBe(10 * 86_400);
  });

  it('scales past the largest fixed step for a multi-year range', () => {
    const r = range(0, 5 * 365 * 86_400_000); // 5 years
    // 5y / 60 buckets ≈ 30.4d/bucket target -> first step >= that is 90 days.
    expect(calcBucketInterval(r)).toBe(90 * 86_400);
  });

  it('falls back to whole-year steps beyond the step table for very long ranges', () => {
    const r = range(0, 200 * 365 * 86_400_000); // 200 years
    // 200y / 60 buckets ≈ 3.33y/bucket target -> rounds up to whole years.
    expect(calcBucketInterval(r)).toBe(4 * 365 * 86_400);
  });

  it('picks the smallest step for a short range', () => {
    const r = range(0, 60_000); // 1 minute
    expect(calcBucketInterval(r)).toBe(10);
  });
});

describe('resolveInterval', () => {
  it('auto mode resolves to SECOND unit with a human label', () => {
    const r = range(0, 3_600_000);
    const resolved = resolveInterval('auto', r);
    expect(resolved.unit).toBe('SECOND');
    expect(resolved.value).toBe(60);
    expect(resolved.label).toBe('Auto - 1 minute');
    expect(resolved.intervalMs).toBe(60_000);
  });

  it('fixed modes resolve to their own CH unit with value 1', () => {
    const r = range(0, 3_600_000);
    expect(resolveInterval('hour', r)).toEqual({
      unit: 'HOUR',
      value: 1,
      label: 'Hour',
      intervalMs: 3_600_000,
    });
    expect(resolveInterval('day', r)).toEqual({
      unit: 'DAY',
      value: 1,
      label: 'Day',
      intervalMs: 86_400_000,
    });
  });
});

describe('estimateBucketCount', () => {
  it('matches ceil(span / stepSeconds) for a fixed mode', () => {
    const r = range(0, 3_600_000); // 1 hour
    expect(estimateBucketCount('minute', r)).toBe(60);
  });

  it('stays close to the ~60-bucket target in auto mode', () => {
    const r = range(0, 3_600_000);
    const count = estimateBucketCount('auto', r);
    expect(count).toBeLessThanOrEqual(60);
    expect(count).toBeGreaterThan(30);
  });
});

describe('fillEmptyBuckets', () => {
  const r = range(0, 300_000); // 5 minutes
  const resolved: ResolvedInterval = { unit: 'MINUTE', value: 1, label: 'Minute', intervalMs: 60_000 };

  it('fills every step in range with a zero bucket when no data points exist', () => {
    const filled = fillEmptyBuckets([], resolved, r);
    // start = floor(0/60000)*60000 = 0; strictly-less-than-end means buckets at 0,60000,...,240000
    expect(filled.map((p) => p.time)).toEqual([0, 60_000, 120_000, 180_000, 240_000]);
    expect(filled.every((p) => Object.keys(p.levels).length === 0)).toBe(true);
  });

  it('preserves real data points at their bucket instead of overwriting them with a filler', () => {
    const points: VolumeDataPoint[] = [{ time: 120_000, levels: { info: 5 } }];
    const filled = fillEmptyBuckets(points, resolved, r);
    const bucket = filled.find((p) => p.time === 120_000);
    expect(bucket?.levels).toEqual({ info: 5 });
  });

  it('does not add a spurious trailing bucket exactly at the range end (see doc comment)', () => {
    // Range span (300000ms) divides evenly by the 60000ms step — a `t <= end` loop would add a
    // bucket at 300000, which this test guards against.
    const filled = fillEmptyBuckets([], resolved, r);
    expect(filled.some((p) => p.time === 300_000)).toBe(false);
  });

  it('leaves week/month/year buckets sparse (calendar-relative anchors, not zero-fillable)', () => {
    const weekResolved: ResolvedInterval = { unit: 'WEEK', value: 1, label: 'Week', intervalMs: 604_800_000 };
    const points: VolumeDataPoint[] = [{ time: 0, levels: { info: 1 } }];
    expect(fillEmptyBuckets(points, weekResolved, r)).toBe(points);
  });

  it('returns points unchanged when intervalMs is zero or missing', () => {
    const zeroResolved: ResolvedInterval = { unit: 'SECOND', value: 0, label: 'x', intervalMs: 0 };
    const points: VolumeDataPoint[] = [{ time: 0, levels: {} }];
    expect(fillEmptyBuckets(points, zeroResolved, r)).toBe(points);
  });
});
