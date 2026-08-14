import { useLayoutEffect, useState } from 'react';

const TICK_MS = 200;

/**
 * A `performance.now()`-scale timestamp for measuring still-`running` spans' durations live.
 * Reads happen inside an effect, not during render — calling `performance.now()` directly in a
 * render body is impure (flagged by the React Compiler's `react-hooks/purity` rule) since it makes
 * the same render produce different output depending on when it happens to run.
 *
 * Uses useLayoutEffect (not useEffect) so the real value lands before the browser paints — with a
 * plain useEffect, a span created at page-load (startMs near 0, same magnitude as this hook's
 * initial placeholder) would render a nonsense negative duration for one visible frame first.
 *
 * Ticks only while `active` is true, so a drawer showing only ended spans never re-renders on a
 * timer at all.
 */
export function useLiveNow(active: boolean): number {
  const [now, setNow] = useState(0);
  useLayoutEffect(() => {
    // Subscribing to an external clock, not deriving state from props/state — the interval below
    // is the same pattern, just deferred; this first call is what makes the very first render (see
    // the module doc comment) correct instead of only the second one.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(performance.now());
    if (!active) {
      return;
    }
    const id = window.setInterval(() => setNow(performance.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}
