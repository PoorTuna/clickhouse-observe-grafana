/**
 * Builds a link into Grafana Explore's ClickHouse trace view for a given trace id, by reusing
 * the "View trace" DataLink that grafana-clickhouse-datasource already stamps onto any query
 * response frame with a `traceID`/`trace_id` field (see its src/data/utils.ts,
 * transformQueryResponseWithTraceAndLogLinks — applied unconditionally in CHDatasource.query()).
 *
 * Our logs query aliases the trace column as `__traceId` (CORE_ALIAS.traceId), which deliberately
 * does not match that detection, so we can't get the link "for free" off our real query. Instead
 * we run a trivial probe query once per datasource to obtain the link *template* (its query still
 * has the placeholder `${__value.raw}` in place of a real trace id), cache it, and interpolate the
 * real trace id into it per click via `mapInternalLinkToExplore` — the same helper Grafana core
 * uses to turn an InternalDataLink into an href.
 *
 * Degrades gracefully: if the datasource has no Traces defaults configured (or the admin disabled
 * `traces.showTraceLinks`), the probe returns no such link and callers get `undefined`.
 */
import { DataLink, Field, ScopedVars, TimeRange, mapInternalLinkToExplore } from '@grafana/data';
import { getTemplateSrv } from '@grafana/runtime';
import { runQuery } from './runQuery';

export interface TraceLinkTemplate {
  link: DataLink;
  field: Field;
}

// Trace ids are hex strings (Datasource.retargetSpanLinkTrace applies the same check). Guards
// against splicing an arbitrary log value into generated SQL via the interpolated query.
const HEX_TRACE_ID = /^[0-9a-fA-F]+$/;

/** True for a non-empty hex string — the same shape ClickHouse/OTel trace ids always have.
 *  Shared with data/traceToLogsLink.ts so both directions of the trace<->logs link agree on
 *  what counts as a valid trace id before it's spliced into generated SQL or a URL param. */
export function isHexTraceId(id: string): boolean {
  return HEX_TRACE_ID.test(id);
}

// One probe (and one in-flight promise) per datasource UID for the life of the session — the
// template is trace-id agnostic and the generated trace-ID SQL carries no $__fromTime/$__toTime
// macros, so it never goes stale with the panel's time range.
const templateCache = new Map<string, Promise<TraceLinkTemplate | null>>();

function findTraceLink(field: Field): DataLink | undefined {
  const links = field.config?.links;
  if (!links || links.length === 0) {
    return undefined;
  }
  return (
    links.find((l) => l.title === 'View trace') ??
    // Fallback in case the datasource ever renames the link: same shape it always builds for
    // the trace-ID mode query.
    links.find((l) => (l.internal?.query as any)?.builderOptions?.meta?.isTraceIdMode === true)
  );
}

async function probeTraceLinkTemplate(
  datasourceUid: string,
  timeRange: TimeRange
): Promise<TraceLinkTemplate | null> {
  try {
    const frames = await runQuery({
      datasourceUid,
      sql: "SELECT '' AS traceID",
      timeRange,
      refId: 'ch-observe-tracelink',
    });
    const field = frames[0]?.fields?.[0];
    if (!field) {
      return null;
    }
    const link = findTraceLink(field);
    return link ? { link, field } : null;
  } catch {
    return null;
  }
}

/** Fetches (and caches) the "View trace" link template for a datasource. */
export function getTraceLinkTemplate(
  datasourceUid: string,
  timeRange: TimeRange
): Promise<TraceLinkTemplate | null> {
  let cached = templateCache.get(datasourceUid);
  if (!cached) {
    cached = probeTraceLinkTemplate(datasourceUid, timeRange);
    templateCache.set(datasourceUid, cached);
  }
  return cached;
}

/** Test-only: clears the per-datasource template cache. */
export function resetTraceLinkCache(): void {
  templateCache.clear();
}

/** Interpolates a real trace id into a cached template, producing an Explore href. */
export function buildTraceExploreHref(
  template: TraceLinkTemplate,
  traceId: string,
  timeRange: TimeRange
): string | undefined {
  if (!isHexTraceId(traceId) || !template.link.internal) {
    return undefined;
  }
  const scopedVars: ScopedVars = { __value: { text: traceId, value: { raw: traceId } } };
  const model = mapInternalLinkToExplore({
    link: template.link,
    internalLink: template.link.internal,
    field: template.field,
    range: timeRange,
    scopedVars,
    replaceVariables: (value, vars) => getTemplateSrv().replace(value, vars ?? scopedVars),
  });
  return model.href || undefined;
}
