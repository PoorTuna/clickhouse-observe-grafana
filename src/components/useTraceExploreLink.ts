/**
 * Resolves a trace id to a ClickHouse Explore trace-view URL, backed by the per-datasource
 * link template in ../data/traceLinks. Returns `undefined` per trace id while the template is
 * loading or when the datasource has no Traces config — callers should treat that as "no link".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { TimeRange } from '@grafana/data';
import { buildTraceExploreHref, getTraceLinkTemplate, TraceLinkTemplate } from '../data/traceLinks';

interface Resolved {
  datasourceUid: string;
  template: TraceLinkTemplate | null;
}

export function useTraceExploreLink(
  datasourceUid: string | undefined,
  timeRange: TimeRange
): (traceId: string) => string | undefined {
  const [resolved, setResolved] = useState<Resolved | null>(null);
  // Guards against a stale resolution (from a previous datasourceUid) landing after the uid
  // has already changed again.
  const requestId = useRef(0);

  useEffect(() => {
    if (!datasourceUid) {
      return;
    }
    const thisRequest = ++requestId.current;
    getTraceLinkTemplate(datasourceUid, timeRange).then((template) => {
      if (requestId.current === thisRequest) {
        setResolved({ datasourceUid, template });
      }
    });
    // Only re-probe when the datasource changes — the template has no time-range dependency
    // (see traceLinks.ts), so timeRange isn't a dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasourceUid]);

  // Derived during render (not stored) so a template resolved for a since-replaced datasourceUid
  // is never used — no dedicated "reset on prop change" effect/ref needed.
  const template = resolved && resolved.datasourceUid === datasourceUid ? resolved.template : null;

  return useCallback(
    (traceId: string) => (template ? buildTraceExploreHref(template, traceId, timeRange) : undefined),
    [template, timeRange]
  );
}
