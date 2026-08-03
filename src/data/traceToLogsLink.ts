/**
 * Builds the "View logs in ClickHouse Observe" link shown in Grafana Explore's trace view header
 * (PluginExtensionPoints.TraceViewHeaderActions) — the reverse direction of ../data/traceLinks.ts.
 *
 * Runs inside Explore, outside our plugin's own React tree, so this module is deliberately pure:
 * no React, no plugin jsonData/config access. Everything it needs arrives via the extension
 * context Grafana core builds for us.
 *
 * The context type is a structural mirror of Grafana core's `TraceViewPluginExtensionContext`
 * (public/app/features/explore/TraceView/components/types/trace.ts, Grafana v13.0.2) — that type
 * is not exported from @grafana/data, only its extension point id
 * (PluginExtensionPoints.TraceViewHeaderActions) is. Core builds it as `{ ...trace, datasource }`
 * where `trace: Trace` carries traceID/startTime/endTime/duration, and that file's header states
 * "All timestamps are in microseconds" (corroborated by core's own `trace.startTime / 1000` when
 * formatting it for display).
 */
import { PLUGIN_BASE_URL } from '../constants';
import { isHexTraceId } from './traceLinks';

/** grafana-clickhouse-datasource's plugin id — the only datasource type this link supports. */
const CLICKHOUSE_DATASOURCE_TYPE = 'grafana-clickhouse-datasource';

// Trace's own time window rarely brackets the surrounding log lines exactly (clock skew between
// services, logs emitted just before the first span or just after the last) — padding by a few
// minutes on each side keeps them in view without requiring the user to widen the range by hand.
const TIME_PAD_MS = 5 * 60 * 1000;

/** Structural mirror of Grafana core's TraceViewPluginExtensionContext — see file doc comment. */
export interface TraceViewLinkContext {
  traceID: string;
  /** Microseconds. */
  startTime: number;
  /** Microseconds. */
  endTime?: number;
  /** Microseconds. */
  duration?: number;
  datasource?: {
    uid: string;
    type: string;
    name?: string;
  };
}

/**
 * Builds the path for our Logs Explorer, filtered to this trace, or `undefined` when the link
 * should not be shown at all (wrong datasource type, or no usable trace id) — the `configure`
 * callback in module.tsx returns `undefined` for exactly the cases this returns `undefined` for,
 * which is how a AppPlugin.addLink link hides itself.
 */
export function buildTraceToLogsPath(ctx: TraceViewLinkContext | undefined): string | undefined {
  if (!ctx || ctx.datasource?.type !== CLICKHOUSE_DATASOURCE_TYPE) {
    return undefined;
  }
  if (!ctx.traceID || !isHexTraceId(ctx.traceID)) {
    return undefined;
  }

  const sp = new URLSearchParams();
  sp.set('traceId', ctx.traceID);
  sp.set('dsUid', ctx.datasource.uid);

  const range = traceTimeRangeMs(ctx);
  if (range) {
    sp.set('from', String(range.from));
    sp.set('to', String(range.to));
  }

  return `${PLUGIN_BASE_URL}/logs?${sp.toString()}`;
}

/** Converts the trace's own (microsecond) window to a padded millisecond {from,to}, or
 *  `undefined` when neither endTime nor startTime+duration yields a finite bound — LogsExplorer
 *  falls back to its own default time range in that case rather than getting a broken one. */
function traceTimeRangeMs(ctx: TraceViewLinkContext): { from: number; to: number } | undefined {
  const startMs = ctx.startTime / 1000;
  const endMs = ctx.endTime !== undefined ? ctx.endTime / 1000 : startMs + (ctx.duration ?? 0) / 1000;

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return undefined;
  }

  return { from: startMs - TIME_PAD_MS, to: endMs + TIME_PAD_MS };
}
