import { TimeRange } from '@grafana/data';

/**
 * Coarse cache-key bucket for a Grafana TimeRange. Relative ranges (e.g. 'now-1h') collapse to
 * their raw string — stable regardless of when "now" is evaluated; absolute ranges snap to 5
 * minutes so a cache entry isn't invalidated on every millisecond of drift.
 *
 * Extracted from components/FieldsContext.tsx (which re-exports it for existing importers) so
 * sql/keys.ts and sql/kql/_values.ts don't have to import a React component module just for this
 * — and so FieldsContext can, in turn, import cache-clearing helpers from sql/keys.ts without a
 * cycle.
 */
export function coarseTimeBucket(timeRange: TimeRange): string {
  // Relative strings (e.g. 'now-1h') → stable key; absolute → round to 5 min.
  if (typeof timeRange.raw.from === 'string') {
    return `${timeRange.raw.from}|${timeRange.raw.to}`;
  }
  const snap = (ms: number) => Math.floor(ms / 300_000) * 300_000;
  return `${snap(timeRange.from.valueOf())}|${snap(timeRange.to.valueOf())}`;
}
