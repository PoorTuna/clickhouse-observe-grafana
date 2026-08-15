/**
 * Thin wrapper to run raw SQL through the installed ClickHouse datasource.
 * The CH datasource backend handles $__fromTime / $__toTime macro expansion.
 */

import { DataQuery, DataQueryError, DataQueryRequest, DataFrame, DataQueryResponse, TimeRange } from '@grafana/data';
import { getDataSourceSrv } from '@grafana/runtime';
import { from, Observable } from 'rxjs';
import { startOrphanRoot } from '../diag/tracer';
import { QueryOp, SpanHandle } from '../diag/types';
import { detectTruncation } from '../diag/sqlIntegrity';
import { appendLogComment, buildLogCommentTag } from '../diag/logComment';
import { isEnrichmentEnabled } from '../diag/enrichment';

// CH datasource format enum (Table = 1). Must match their src/types/sql.ts.
const FORMAT_TABLE = 1;

interface ChTarget extends DataQuery {
  rawSql: string;
  editorType: 'sql';
  format: number;
}

/**
 * Extracts every piece of information a DataQueryError actually carries, instead of picking one
 * field and discarding the rest. `.message` is usually the whole ClickHouse exception text, but
 * `.data.message`/`.data.error` (dev-mode detail) and `.status`/`.statusText` (e.g. 504 from a
 * proxy timing out before ClickHouse itself responds) can be the only signal present when
 * `.message` is empty or generic — never collapse those into a fixed "query failed" string, or a
 * real timeout/permissions/network distinction gets thrown away right when it matters most.
 */
function formatDataQueryError(err: DataQueryError): string {
  const parts = [
    err.message,
    err.data?.message,
    err.data?.error,
    err.status != null ? `HTTP ${err.status}${err.statusText ? ` ${err.statusText}` : ''}` : undefined,
  ].filter((p): p is string => Boolean(p && p.trim()));
  if (parts.length > 0) {
    // dedupe: .message and .data.message are frequently the same string verbatim.
    return Array.from(new Set(parts)).join(' — ');
  }
  // No known field had anything — surface the raw object rather than a generic placeholder, so
  // whatever shape the backend actually sent is still visible instead of silently discarded.
  try {
    return `ClickHouse query failed: ${JSON.stringify(err)}`;
  } catch {
    return 'ClickHouse query failed with an error that could not be serialized.';
  }
}

export interface RunQueryOptions {
  datasourceUid: string;
  sql: string;
  timeRange: TimeRange;
  /**
   * Identifies which of the plugin's query call sites issued this request — see diag/types.ts's
   * `QueryOp` for the full closed set. Required, not optional: 8 of the 12 call sites this tracer
   * now covers previously passed no `refId` at all and would otherwise show up anonymous in the
   * diagnostics drawer. Making this required turns "a new call site forgot to identify itself"
   * into a compile error instead of a silent gap in coverage.
   */
  op: QueryOp;
  refId?: string;
  maxDataPoints?: number;
  /**
   * When aborted before the query settles, `runQuery` unsubscribes from the underlying Observable
   * early instead of waiting for (and decoding) a response nobody will use.
   *
   * This does **not** cancel the query on ClickHouse. Verified against Grafana core's
   * `backend_srv.ts`: `DataSourceWithBackend.query()` (which the CH datasource extends) issues its
   * HTTP request through `getBackendSrv().fetch()`, and that method's Observable is not wired to an
   * `AbortController` on unsubscribe — only the separate streaming `chunked()` path is. So
   * ClickHouse keeps running an abandoned query regardless of this signal firing; a superseded
   * search still costs the server its full execution time. What aborting *does* buy: this promise
   * settles immediately (as an `AbortError`) instead of waiting out the abandoned request, and the
   * span this call produces is marked `cancelled` rather than left `running` forever. Real
   * server-side cancellation needs `KILL QUERY` against a `query_id`, which is a separate, larger
   * piece (see the diagnostics plan's Phase 2 addendum) — don't infer from this option's existence
   * that abandoned queries stop costing ClickHouse anything, because they don't.
   */
  signal?: AbortSignal;
  /**
   * The action this query's diagnostics span should attach under. Omit for background work with
   * no gesture behind it (mount-time discovery, an auto-refresh tick, a cache miss) — `runQuery`
   * then opens its own root span named after `op`, so coverage is total rather than opt-in (see
   * the diagnostics plan's "Root attribution, including work with no gesture behind it").
   *
   * Deliberately explicit rather than ambient/inferred: this plugin fires concurrent queries by
   * design (one search submit kicks off logs + volume + presence together), so a global "current
   * action" would misattribute the moment two actions' async work interleaves.
   */
  trace?: SpanHandle;
}

/**
 * Runs the query span end-to-end: builds the request, subscribes (with abort support), and
 * surfaces backend errors as a rejection — see the manual-subscribe comment below for why this
 * isn't `lastValueFrom`. Shared by `runQuery` and `runQueryRows` so a call is only ever traced
 * once, whichever one the caller uses.
 *
 * `span` is optional so `runQueryUntracedRows` (the diagnostics tier's own infrastructure queries)
 * can reuse this without producing a tracer span for itself — see that function's doc comment.
 */
async function fetchFrames(options: RunQueryOptions, span: SpanHandle | undefined): Promise<DataFrame[]> {
  const { datasourceUid, sql: originalSql, timeRange, refId = 'A', maxDataPoints = 5000, signal, op } = options;

  if (signal?.aborted) {
    throw new DOMException('The query was aborted before it started.', 'AbortError');
  }

  // Server-side enrichment tagging (diagnostics plan Phase 2) — every real query gets a
  // `log_comment` naming its trace+span+op when the user has opted in, EXCEPT the lookup query
  // that reads log_comment back out of system.query_log, which must never tag (and thus never
  // match) itself. `span` is only absent for that lookup (see runQueryUntracedRows), so gating on
  // `span &&` here is equivalent to gating on "not the lookup query" and reads more directly.
  const sql =
    span && op !== 'serverStatsLookup' && isEnrichmentEnabled()
      ? appendLogComment(originalSql, buildLogCommentTag(span.span.rootId, span.span.id, op))
      : originalSql;

  const ds = await getDataSourceSrv().get(datasourceUid);

  const target: ChTarget = {
    refId,
    rawSql: sql,
    editorType: 'sql',
    format: FORMAT_TABLE,
  };

  const request: DataQueryRequest<ChTarget> = {
    requestId: `ch-observe-${refId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    app: 'dashboard',
    interval: '1m',
    intervalMs: 60000,
    maxDataPoints,
    range: timeRange,
    scopedVars: {},
    targets: [target],
    timezone: 'browser',
    startTime: Date.now(),
  };

  const result = ds.query(request);
  const response$ = (result instanceof Observable ? result : from(result)) as Observable<DataQueryResponse>;

  // Manual subscribe (rather than lastValueFrom) so an abort can unsubscribe early. Mirrors
  // lastValueFrom's own semantics otherwise: resolve with the last emitted value, reject if the
  // observable completes having never emitted one.
  const response = await new Promise<DataQueryResponse>((resolve, reject) => {
    let lastValue: DataQueryResponse | undefined;
    let hadValue = false;

    const onAbort = () => {
      subscription.unsubscribe();
      reject(new DOMException('The query was aborted.', 'AbortError'));
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    const subscription = response$.subscribe({
      next: (value) => {
        lastValue = value;
        hadValue = true;
      },
      error: (err) => {
        cleanup();
        reject(err);
      },
      complete: () => {
        cleanup();
        if (hadValue) {
          resolve(lastValue as DataQueryResponse);
        } else {
          reject(new Error('ClickHouse datasource query() completed without emitting a response.'));
        }
      },
    });

    signal?.addEventListener('abort', onAbort, { once: true });
  });
  // The datasource resolves (never rejects) on a backend-reported query failure — Grafana's
  // DataQueryResponse carries `.error`/`.errors` *alongside* `.data` rather than throwing (see
  // @grafana/runtime's toDataQueryResponse, and CHDatasource.query()'s own catchError, which both
  // only ever emit a resolved value). Without this check every ClickHouse error (bad SQL, a
  // `timeout_overflow_mode = 'throw'` guardrail firing, permissions) would silently surface here as
  // an empty/partial `data` array instead of a catchable error.
  if (response.errors?.length || response.error) {
    // Prefer .errors[0] (the newer, non-deprecated field) but fall back to .error — either can be
    // populated alone depending on which layer produced it (see runQuery.ts's C0 doc comment
    // above). Every field either one carries is surfaced via formatDataQueryError, never just one.
    const err = response.errors?.[0] ?? response.error!;
    throw new Error(formatDataQueryError(err));
  }
  const frames = response.data as DataFrame[];
  // The CH datasource populates frame.meta.executedQueryString with the post-macro SQL (after
  // $__fromTime/$__timeInterval expansion) — strictly more useful than the pre-expansion builder
  // SQL SqlInspectorBar.tsx shows, and previously discarded entirely the moment runQueryRows
  // flattened frames to rows. Attach it to the span rather than losing it.
  const executedSql = frames?.[0]?.meta?.executedQueryString;
  span?.setAttrs({ sql, ...(executedSql ? { executedSql } : {}) });
  return frames;
}

/**
 * Runs `fn` under a query span for `options.op`, attached to `options.trace` if given or its own
 * orphan root otherwise (see RunQueryOptions.trace). Ends the span exactly once, classifying the
 * outcome as `cancelled` (an AbortError from `fetchFrames`'s abort handling) vs `error` (anything
 * else) vs `ok`.
 */
async function traced<T>(options: RunQueryOptions, fn: (span: SpanHandle) => Promise<T>): Promise<T> {
  const span = options.trace ? options.trace.child(options.op, options.op) : startOrphanRoot(options.op);
  try {
    const result = await fn(span);
    span.end('ok');
    return result;
  } catch (err) {
    const isAbort = err instanceof DOMException && err.name === 'AbortError';
    if (isAbort) {
      span.end('cancelled');
    } else {
      span.setError(err instanceof Error ? err.message : String(err));
      span.end('error');
    }
    throw err;
  }
}

export async function runQuery(options: RunQueryOptions): Promise<DataFrame[]> {
  return traced(options, (span) => fetchFrames(options, span));
}

/** Convert a DataFrame into an array of plain row objects. */
export function dataFrameToRows(frame: DataFrame): Array<Record<string, unknown>> {
  if (!frame || frame.length === 0) {
    return [];
  }
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < frame.length; i++) {
    const row: Record<string, unknown> = {};
    for (const field of frame.fields) {
      // The ClickHouse Grafana datasource prefixes Map-typed column names with
      // "_f_col_" in the DataFrame. Strip it so downstream code sees the SQL alias.
      const name = field.name.replace(/^_f_col_/, '');
      row[name] = field.values[i];
    }
    rows.push(row);
  }
  return rows;
}

/** Run a query and return rows from the first DataFrame. */
export async function runQueryRows(
  options: RunQueryOptions
): Promise<Array<Record<string, unknown>>> {
  return traced(options, async (span) => {
    const frames = await fetchFrames(options, span);
    if (!frames || frames.length === 0) {
      return [];
    }
    // A real, measured child span (as opposed to the 'transport'/'clickhouse' split in
    // diag/autoEnrich.ts, which is reconstructed after the fact from system.query_log stats that
    // land seconds later) — this one is cheap to time live since dataFrameToRows runs synchronously
    // right here.
    const decodeSpan = span.child('decode', 'decode');
    const rows = dataFrameToRows(frames[0]);
    decodeSpan.end('ok');
    // truncated is undefined (not false) when options.sql has no LIMIT at all — "not applicable"
    // and "confirmed not truncated" are different facts the Warnings tab shouldn't conflate. See
    // diag/sqlIntegrity.ts's detectTruncation doc comment.
    const truncated = detectTruncation(options.sql, rows.length);
    span.setAttrs({ rowCount: rows.length, ...(truncated !== undefined ? { truncated } : {}) });
    return rows;
  });
}

/**
 * Escape hatch for the diagnostics tier's own infrastructure queries (currently only
 * diag/serverStats.ts's system.query_log lookup) — runs a query WITHOUT creating a tracer span
 * for it and WITHOUT log_comment tagging it. Both matter for the same reason: this query exists to
 * populate the diagnostics UI, not to be diagnosed itself — a traced lookup would clutter the
 * activity rail with one extra entry per poll attempt per enriched action, and a tagged lookup
 * would (harmlessly, but confusingly) show up as its own row the next time it ran.
 *
 * Deliberately not exposed as a `trace: undefined` case of the normal `runQueryRows` — that already
 * means "no gesture behind this, give it its own orphan root," a real and desired behavior for the
 * other 12 call sites. This function means something categorically different: "don't trace at
 * all," which only this one caller should ever want.
 */
export async function runQueryUntracedRows(
  options: Omit<RunQueryOptions, 'trace'>
): Promise<Array<Record<string, unknown>>> {
  const frames = await fetchFrames(options, undefined);
  if (!frames || frames.length === 0) {
    return [];
  }
  return dataFrameToRows(frames[0]);
}
