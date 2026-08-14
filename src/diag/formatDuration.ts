/**
 * Formats a span duration for the diagnostics drawer. Sub-second durations show as whole
 * milliseconds ("310ms"); one second and up switches to seconds with two decimals ("1.84s") so a
 * long-running query doesn't display as an unreadable 5-digit millisecond count.
 */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

/** ms elapsed so far for a still-running span, or its final duration once ended. */
export function spanDurationMs(startMs: number, endMs: number | null, nowMs: number): number {
  return (endMs ?? nowMs) - startMs;
}
