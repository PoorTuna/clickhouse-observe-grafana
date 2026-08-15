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

/**
 * ms elapsed so far for a still-running span, or its final duration once ended. Clamped to zero —
 * a span whose end() call raced against something else (e.g. a reconstructed child span, or a
 * cleanup path closing a span slightly out of order under fast successive re-renders) should never
 * surface as a negative duration to the user; that reads as a bug in the tool, not a real timing
 * fact, so zero (rather than the literal negative delta) is what a caller should ever see.
 */
export function spanDurationMs(startMs: number, endMs: number | null, nowMs: number): number {
  return Math.max(0, (endMs ?? nowMs) - startMs);
}
