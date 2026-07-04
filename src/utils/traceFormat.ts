/** Format a nanosecond duration (span/trace durationNs) for display. */
export function formatNs(ns: number): string {
  if (ns >= 1e9) {
    return `${(ns / 1e9).toFixed(2)}s`;
  }
  if (ns >= 1e6) {
    return `${(ns / 1e6).toFixed(2)}ms`;
  }
  if (ns >= 1e3) {
    return `${(ns / 1e3).toFixed(2)}µs`;
  }
  return `${Math.max(ns, 0)}ns`;
}

/** Format a millisecond duration (aggregate stats already in ms) for display. */
export function formatMs(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  return `${ms.toFixed(1)}ms`;
}
