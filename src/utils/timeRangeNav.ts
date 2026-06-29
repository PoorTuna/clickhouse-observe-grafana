import { dateTime, TimeRange } from '@grafana/data';

/**
 * Build an absolute TimeRange from two epoch-millisecond values.
 * All arithmetic in this module stays on epoch ms so there is zero
 * timezone-offset drift — no wall-clock components are ever read.
 */
function makeRange(fromMs: number, toMs: number): TimeRange {
  return {
    from: dateTime(fromMs),
    to: dateTime(toMs),
    raw: { from: dateTime(fromMs), to: dateTime(toMs) },
  };
}

/**
 * Shift the time window by its own span.
 *   direction = -1 → move backward (earlier)
 *   direction =  1 → move forward (later)
 *
 * A relative window (e.g. "now-1h" / "now") becomes an absolute window
 * after the first shift — this matches Grafana core behaviour.
 */
export function shiftTimeRange(range: TimeRange, direction: 1 | -1): TimeRange {
  const from = range.from.valueOf();
  const to = range.to.valueOf();
  const span = to - from;
  return makeRange(from + direction * span, to + direction * span);
}

/**
 * Zoom the window out around its midpoint.
 * factor = 2 → double the span (Grafana default zoom-out factor).
 * There is no zoom-in; Grafana's TimeRangePicker only exposes onZoom (out).
 */
export function zoomOutTimeRange(range: TimeRange, factor = 2): TimeRange {
  const from = range.from.valueOf();
  const to = range.to.valueOf();
  const span = to - from;
  const center = to - span / 2;
  const newSpan = span * factor;
  return makeRange(center - newSpan / 2, center + newSpan / 2);
}
