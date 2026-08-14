/**
 * Shared types for the diagnostics tracer (src/diag/tracer.ts). Split out from tracer.ts purely
 * so consumers (the drawer UI, runQuery.ts) can import types without pulling in the tracer's
 * mutable state.
 */

export type SpanStatus = 'running' | 'ok' | 'error' | 'cancelled';

/**
 * `op` names every query-shaped unit of work in the plugin — see runQuery.ts's `RunQueryOptions.op`
 * for where each one is actually issued. Kept here (rather than inferred from `refId`) because
 * `refId` was optional and unnamed at 8 of the 12 call sites before this tracer existed; `op` is a
 * required, closed set precisely so a call site can't stay anonymous.
 */
export type QueryOp =
  | 'logs'
  | 'volume'
  | 'detailPage'
  | 'detailRow'
  | 'loadMore'
  | 'columns'
  | 'mapKeys'
  | 'jsonPaths'
  | 'presence'
  | 'fieldValues'
  | 'traceLink'
  | 'wizardDatabases'
  | 'wizardTables'
  | 'wizardColumns'
  | 'wizardJsonPaths'
  /** The diagnostics drawer's own system.query_log lookup (see diag/serverStats.ts) — reserved so
   *  it can be excluded from log_comment tagging (it must never appear in its own results) and
   *  run untraced (see runQuery.ts's runQueryUntracedRows), so it never clutters the activity
   *  rail it exists to populate. */
  | 'serverStatsLookup';

/** Non-query phases a span can represent, alongside the QueryOps above. */
export type SpanKind = QueryOp | 'action' | 'build' | 'transport' | 'clickhouse' | 'decode' | 'render';

export interface SpanAttrs {
  [key: string]: unknown;
}

export interface Span {
  id: string;
  parentId: string | null;
  /** id of the top-level (action or orphaned-query) span this one descends from; equals `id` for a root. */
  rootId: string;
  name: string;
  kind: SpanKind;
  startMs: number;
  endMs: number | null;
  status: SpanStatus;
  attrs: SpanAttrs;
  error?: string;
  children: Span[];
}

/**
 * What a caller actually holds and mutates. `span` is a live reference into the tracer's tree —
 * reading it after `end()` is safe and reflects the final state, since the tracer notifies
 * subscribers by mutating in place and bumping a version counter rather than reallocating.
 */
export interface SpanHandle {
  readonly span: Span;
  child(name: string, kind: SpanKind, attrs?: SpanAttrs): SpanHandle;
  end(status?: Exclude<SpanStatus, 'running'>, attrs?: SpanAttrs): void;
  setAttrs(attrs: SpanAttrs): void;
  setError(message: string): void;
}

/**
 * What callers thread through `RunQueryOptions.trace` (runQuery.ts) to attach a query's spans to
 * the action that triggered it, instead of the tracer trying to infer "what's currently happening"
 * from ambient/global mutable state — which breaks the moment two actions' async work interleaves,
 * exactly the situation this plugin is in by design (a search submits logs + volume + presence
 * concurrently). Passing the handle explicitly means attribution is always correct, never a race.
 */
export type TraceParent = SpanHandle | undefined;
