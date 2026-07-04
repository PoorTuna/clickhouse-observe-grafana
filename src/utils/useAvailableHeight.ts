import { RefObject, useEffect, useState } from 'react';

/**
 * Measures the actual viewport space available below a container's top edge.
 *
 * Grafana's own page chrome under `PageLayoutType.Custom` (`main-view` / `page-content` /
 * `page-panes`) does not clamp itself to the viewport — those elements auto-grow to fit their
 * content, with `overflow-y: visible`. A CSS `height: 100%` chain on our own container therefore
 * resolves against nothing and the whole page just grows to fit everything, including a
 * virtualized list's full (unrendered-until-scrolled) row count — defeating virtualization
 * entirely, since `@tanstack/react-virtual` needs a scroll container with a real, bounded
 * `clientHeight` to compute which rows are actually visible. Measuring the viewport directly in
 * JS sidesteps the ancestor chain altogether.
 */
export function useAvailableHeight(ref: RefObject<HTMLElement>, minHeight = 300): number | undefined {
  const [height, setHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    function update() {
      if (!ref.current) {
        return;
      }
      const top = ref.current.getBoundingClientRect().top;
      setHeight(Math.max(window.innerHeight - top, minHeight));
    }
    update();
    window.addEventListener('resize', update);
    // Grafana's own chrome (nav collapse, breadcrumbs) can change the container's top offset
    // without a window resize firing — a short settle-timer after mount covers that case cheaply.
    const t = setTimeout(update, 300);
    return () => {
      window.removeEventListener('resize', update);
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minHeight]);

  return height;
}
