/**
 * In-memory span tracer for the diagnostics drawer (see the "End-to-end query diagnostics" plan).
 * Every user action (a search submit, a filter change) or orphaned background query (mount-time
 * field discovery, an auto-refresh tick) is a root span; query phases (build SQL, the ClickHouse
 * round-trip, decode) are its children.
 *
 * Deliberately not ambient/global-context-based: a query attaches to an action by receiving that
 * action's SpanHandle explicitly (see TraceParent in types.ts), never by asking the tracer "what's
 * currently happening." This codebase fires concurrent queries by design (one search submit kicks
 * off logs + volume together, plus the sidebar's own on-demand mapKeys/jsonPaths queries), so any
 * "current action" global would be a race the moment two actions' async work interleaves — which
 * defeats the entire point of a tool whose job is correct attribution.
 *
 * State lives in module scope (like a logger), not behind React Context, so instrumentation in
 * runQuery.ts and the SQL builders never needs to be inside a component tree to record a span.
 * DiagContext.tsx is the (thin) React adapter on top of this.
 */

import { Span, SpanAttrs, SpanHandle, SpanKind, SpanStatus, QueryOp } from './types';

const RING_SIZE = 20;

let roots: Span[] = [];
let version = 0;
let seq = 0;
const listeners = new Set<() => void>();
const rootEndListeners = new Set<(span: Span) => void>();

function notify(): void {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

// performance.now() is monotonic and immune to wall-clock adjustments, which matters more than
// epoch accuracy for measuring a span's own duration — jsdom polyfills it, so this is safe in
// tests too. Falls back to Date.now() only if something stranger than jsdom is missing it.
function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function nextId(): string {
  seq += 1;
  return `span-${seq}`;
}

function makeSpan(name: string, kind: SpanKind, parentId: string | null, rootId: string | null): Span {
  const id = nextId();
  const span: Span = {
    id,
    parentId,
    rootId: rootId ?? id,
    // Coerced, not trusted as-is: `name` is typed `string`, but a caller can still hand this a
    // non-string at runtime (see LogsExplorer.tsx's executeQuery doc comment for the real incident
    // — a UI widget invoked a `() => void`-typed callback with a click SyntheticEvent anyway). This
    // span's `name` ends up rendered directly as React children in the rail/waterfall, so the
    // safety net belongs here, at the one place every span is created, not at each call site.
    name: typeof name === 'string' && name ? name : String(kind),
    kind,
    startMs: nowMs(),
    endMs: null,
    status: 'running',
    attrs: {},
    children: [],
  };
  if (parentId === null) {
    // Wall-clock stamp for the activity rail's "when" display — see the module doc comment on
    // why span timing itself stays on performance.now() instead.
    span.attrs.startedAt = Date.now();
  }
  return span;
}

function makeHandle(span: Span): SpanHandle {
  return {
    span,
    child(name: string, kind: SpanKind, attrs?: SpanAttrs): SpanHandle {
      const childSpan = makeSpan(name, kind, span.id, span.rootId);
      if (attrs) {
        childSpan.attrs = { ...childSpan.attrs, ...attrs };
      }
      span.children.push(childSpan);
      notify();
      return makeHandle(childSpan);
    },
    end(status: Exclude<SpanStatus, 'running'> = 'ok', attrs?: SpanAttrs): void {
      // Idempotent: a caller that ends a span twice (e.g. both a success path and a finally
      // block) must not let the second call clobber the real status/duration with 'ok'.
      if (span.endMs != null) {
        return;
      }
      span.endMs = nowMs();
      span.status = status;
      if (attrs) {
        span.attrs = { ...span.attrs, ...attrs };
      }
      notify();
      if (span.parentId === null) {
        for (const listener of rootEndListeners) {
          listener(span);
        }
      }
    },
    setAttrs(attrs: SpanAttrs): void {
      span.attrs = { ...span.attrs, ...attrs };
      notify();
    },
    setError(message: string): void {
      span.error = message;
      notify();
    },
  };
}

function pushRoot(span: Span): void {
  roots.push(span);
  if (roots.length > RING_SIZE) {
    // Ring buffer: oldest evicted first. Auto-refresh ticks are the case this matters for most —
    // see the diagnostics plan's "auto-refresh floods the rail" note — but that collapsing happens
    // one layer up (the drawer groups consecutive healthy auto-refresh roots); the tracer itself
    // stays a plain bounded FIFO.
    roots.shift();
  }
  notify();
}

/** Root span for an explicit UI gesture — search submit, filter change, time-range change, etc. */
export function startAction(name: string): SpanHandle {
  const span = makeSpan(name, 'action', null, null);
  pushRoot(span);
  return makeHandle(span);
}

/**
 * Root span for query work with no gesture driving it — mount-time field discovery, an
 * auto-refresh tick, a sidebar cache miss. Named after `op` so it is never anonymous in the
 * activity list; this is what makes tracer coverage total rather than opt-in (every one of the 12
 * `runQuery` call sites ends up as *some* root or child span, never silently uninstrumented).
 */
export function startOrphanRoot(op: QueryOp): SpanHandle {
  const span = makeSpan(op, op, null, null);
  pushRoot(span);
  return makeHandle(span);
}

/** Current roots, oldest first. Read live during render — see DiagContext.tsx for why this isn't
 *  wrapped in a memoized/copied snapshot. */
export function getRoots(): readonly Span[] {
  return roots;
}

/**
 * Wipes the activity rail — the user-facing "Clear activity" action in the drawer, for when
 * accumulated history (e.g. from before a deliberate test run) is just noise. Reloading the page
 * already does this implicitly (module-scoped state resets on every fresh script execution — there
 * is no persistence layer for spans, only diag/enrichment.ts's toggle uses localStorage), so this
 * exists for clearing without losing the rest of the page's state (filters, time range, scroll).
 */
export function clearRoots(): void {
  roots = [];
  notify();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Fires once, synchronously, whenever a ROOT span ends (action or orphan — never a child). This is
 * the hook diag/autoEnrich.ts uses to kick off a single system.query_log lookup per finished
 * action, rather than per individual query — see that module's doc comment. Kept generic and
 * domain-agnostic here (no ClickHouse/runQuery knowledge in this file) so the dependency points
 * one way: autoEnrich.ts knows about tracer.ts, never the reverse.
 */
export function onRootEnd(listener: (span: Span) => void): () => void {
  rootEndListeners.add(listener);
  return () => rootEndListeners.delete(listener);
}

/**
 * Mutates a span's attrs and notifies subscribers, for callers that only hold a raw `Span`
 * reference rather than the `SpanHandle` that created it — currently only diag/autoEnrich.ts,
 * which discovers spans via `onRootEnd`'s callback, not by creating them itself.
 */
export function setSpanAttrs(span: Span, attrs: SpanAttrs): void {
  span.attrs = { ...span.attrs, ...attrs };
  notify();
}

/**
 * Adds an already-finished child span with explicit historical timestamps, for a span whose
 * timing is reconstructed after the fact from external data rather than measured live via
 * `child()`/`end()` — currently only diag/autoEnrich.ts's `clickhouse`/`transport` split, computed
 * once `system.query_log` stats land (seconds after the query itself finished, so `child()`'s own
 * "start now, end later" shape doesn't fit: "now" is long past the interval being described).
 */
export function addHistoricalChild(
  parent: Span,
  name: string,
  kind: SpanKind,
  startMs: number,
  endMs: number,
  status: Exclude<SpanStatus, 'running'>,
  attrs?: SpanAttrs
): Span {
  const child: Span = {
    id: nextId(),
    parentId: parent.id,
    rootId: parent.rootId,
    name,
    kind,
    startMs,
    endMs,
    status,
    attrs: attrs ? { ...attrs } : {},
    children: [],
  };
  parent.children.push(child);
  notify();
  return child;
}

/** Monotonically increasing counter, bumped on every span mutation — the actual value passed to
 *  React's useSyncExternalStore, since `roots` mutates in place and can't be compared by identity. */
export function getVersion(): number {
  return version;
}

/** Test-only: reset all module-scoped state between test files/cases. */
export function __resetForTests(): void {
  roots = [];
  version = 0;
  seq = 0;
  listeners.clear();
  rootEndListeners.clear();
}
