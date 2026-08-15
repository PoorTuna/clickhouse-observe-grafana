/**
 * Wires diag/serverStats.ts's system.query_log lookup to tracer.ts's root-lifecycle hook, so
 * enrichment happens once per finished action/orphan root — never per individual query — and
 * happens regardless of whether the diagnostics drawer is open (see the diagnostics plan's
 * "Capture scope": the action you want to inspect already finished by the time you notice
 * something was wrong and go look, so capture can't be gated on the drawer being open).
 *
 * `startAutoEnrichment` is called once from App.tsx with a context getter (not a snapshot) — the
 * datasource/config/time-range in scope when a root *ends* is what matters, not what was in scope
 * when the app mounted.
 *
 * Every root that ends while enrichment is on joins a single shared poll cycle here, rather than
 * starting its own — see the B3 finding this batching fixes. Before it, each ended root ran an
 * independent 3-attempt backoff loop calling diag/serverStats.ts on its own; one auto-refresh tick
 * (one 'Auto-refresh' action plus its background 'volume'/'logs'/'presence'/'jsonPaths'/'mapKeys'
 * orphan roots) could fire up to ~18 extra system.query_log scans, each over a 10-minute window —
 * the debugger measurably loading the very server it exists to help debug, a direct violation of
 * the diagnostics plan's own "the debugger must not slow the thing being debugged" constraint.
 */
import { SourceConfig } from '../types';
import { addHistoricalChild, onRootEnd, setSpanAttrs } from './tracer';
import { fetchServerStats, ServerStatsRow } from './serverStats';
import { isEnrichmentEnabled } from './enrichment';
import { flattenSpanTree, querySpans } from './spanTree';
import { Span } from './types';

export interface EnrichmentContext {
  datasourceUid: string;
  config: SourceConfig;
}

// How long to let ended roots accumulate before the first lookup fires — batches a burst of roots
// ending together (e.g. one search submit's logs+volume+presence+discovery all settling within
// milliseconds of each other) into the same query instead of one each.
const BATCH_DEBOUNCE_MS = 500;
// Backoff between lookup rounds once a batch starts, riding out system.query_log's async flush
// (flush_interval_milliseconds defaults to 7500ms) — same shape as the old per-root loop, just now
// shared across every root in the batch instead of duplicated per root.
const POLL_ROUND_DELAYS_MS = [1000, 3000, 8000];

interface PendingEntry {
  root: Span;
  /** spanIds already stamped from a previous round this batch cycle — see applyRows/pruneCompleted.
   *  Tracked so a root whose queries flush across multiple system.query_log rounds (see the B5
   *  finding) keeps polling until every one of its query spans is matched or rounds run out,
   *  instead of stopping the moment any single row arrives. */
  matchedSpanIds: Set<string>;
}

let pending = new Map<string, PendingEntry>(); // keyed by traceId (root.id)
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let activeController: AbortController | null = null;
let started = false;
let disposed = false;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

/**
 * Idempotent — a second call just replaces the context getter, it never double-subscribes (App.tsx
 * mounts once in practice, but React StrictMode's double-invoke in dev shouldn't double-enrich).
 * Returns a real disposer (see the B9 finding): the previous version's disposer was a no-op stub
 * once `started` had ever flipped true, so an in-flight poll cycle and its pending timers/aborts
 * outlived `clearRoots()` or a hot-reload, mutating spans nobody could see anymore and calling
 * `notify()` for no reason.
 */
export function startAutoEnrichment(getContext: () => EnrichmentContext | undefined): () => void {
  if (started) {
    return () => {};
  }
  started = true;
  disposed = false;
  const unsubscribe = onRootEnd((root) => {
    if (!isEnrichmentEnabled()) {
      // Stamped explicitly rather than left unset: this root's queries never carried a
      // log_comment tag (tagging happens per-query, at the moment each query ran — see
      // runQuery.ts's fetchFrames), so no system.query_log row will ever match it, even if the
      // toggle gets flipped on later. Without this, the drawer had no way to tell "this will
      // never arrive" apart from "still polling" — both looked like an unset attr, and both
      // rendered as "waiting to flush" forever for the never-tagged case. See StatsTable.tsx.
      setSpanAttrs(root, { serverStatsStatus: 'not-tagged' });
      return;
    }
    const ctx = getContext();
    if (!ctx) {
      setSpanAttrs(root, { serverStatsStatus: 'not-tagged' });
      return;
    }
    // Distinct from the untouched/undefined state above: this root's queries WERE tagged and a
    // lookup is genuinely queued. See serverStats.ts's ServerStatsResult doc comment for why
    // "pending" and "no-data" need to stay different facts in the data model.
    setSpanAttrs(root, { serverStatsStatus: 'pending' });
    pending.set(root.id, { root, matchedSpanIds: new Set() });
    scheduleFlush(getContext);
  });

  return () => {
    disposed = true;
    started = false;
    unsubscribe();
    if (flushTimer != null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    activeController?.abort();
    activeController = null;
    pending.clear();
  };
}

function scheduleFlush(getContext: () => EnrichmentContext | undefined): void {
  if (flushTimer != null || disposed) {
    return; // a batch is already queued (or about to run) — the new root just joined it via `pending`
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void runBatch(getContext);
  }, BATCH_DEBOUNCE_MS);
}

/** One full poll cycle over whatever's in `pending` at the moment it starts. Roots that arrive
 *  while a cycle is already running are picked up by that cycle's next round (each round re-reads
 *  `pending`'s current keys) rather than waiting for a whole separate cycle. */
async function runBatch(getContext: () => EnrichmentContext | undefined): Promise<void> {
  if (disposed || pending.size === 0) {
    return;
  }
  const ctx = getContext();
  if (!ctx) {
    for (const { root } of pending.values()) {
      setSpanAttrs(root, { serverStatsStatus: 'not-tagged' });
    }
    pending.clear();
    return;
  }

  const controller = new AbortController();
  activeController = controller;
  try {
    for (const delay of POLL_ROUND_DELAYS_MS) {
      if (disposed || pending.size === 0) {
        return;
      }
      try {
        await sleep(delay, controller.signal);
      } catch {
        return; // aborted mid-wait (disposer or a fresh __resetForTests) — bail without finalizing
      }
      if (disposed || pending.size === 0) {
        return;
      }

      const traceIds = [...pending.keys()];
      const result = await fetchServerStats(ctx.datasourceUid, ctx.config, traceIds, controller.signal);
      if (result.status === 'unavailable') {
        // Definite error — no retry, same as the old per-root behavior (a permission/readonly
        // failure won't fix itself between rounds). Finalize every still-pending root with it.
        for (const { root } of pending.values()) {
          setSpanAttrs(root, {
            serverStatsStatus: 'unavailable',
            serverStatsReason: result.reason,
            serverStatsDetail: result.detail,
          });
        }
        pending.clear();
        return;
      }
      if (result.status === 'ok') {
        applyRows(result.rows);
      }
      pruneFullyMatched();
    }
  } finally {
    activeController = null;
    if (!disposed) {
      finalizeRemaining();
    }
  }
}

/** Distributes one round's rows to whichever pending roots they belong to (by `traceId`), applying
 *  each row to its span exactly once even across multiple rounds. */
function applyRows(rows: readonly ServerStatsRow[]): void {
  const byTrace = new Map<string, ServerStatsRow[]>();
  for (const row of rows) {
    const bucket = byTrace.get(row.traceId);
    if (bucket) {
      bucket.push(row);
    } else {
      byTrace.set(row.traceId, [row]);
    }
  }
  for (const [traceId, entry] of pending) {
    const rowsForRoot = byTrace.get(traceId);
    if (!rowsForRoot || rowsForRoot.length === 0) {
      continue;
    }
    setSpanAttrs(entry.root, { serverStatsStatus: 'ok' });
    const bySpanId = new Map(rowsForRoot.map((row) => [row.spanId, row]));
    for (const { span } of flattenSpanTree(entry.root)) {
      if (entry.matchedSpanIds.has(span.id)) {
        continue;
      }
      const row = bySpanId.get(span.id);
      if (row) {
        applyRowToSpan(span, row);
        entry.matchedSpanIds.add(span.id);
      }
    }
  }
}

/** Drops roots from `pending` once every one of their query spans has been matched — no reason to
 *  keep polling for a root that's already fully resolved (see the B5 finding this completeness
 *  check is part of). A root with zero query spans (nothing to match) is left in `pending` for the
 *  caller's normal round budget rather than special-cased, since that's rare and harmless either
 *  way. */
function pruneFullyMatched(): void {
  for (const [traceId, entry] of pending) {
    const total = querySpans(entry.root).length;
    if (total > 0 && entry.matchedSpanIds.size >= total) {
      pending.delete(traceId);
    }
  }
}

/** Called once the round budget is exhausted (or the batch was aborted mid-wait). Anything still in
 *  `pending` never got a single matching row across any round — a genuine "nothing arrived" for the
 *  whole action, so it gets `no-data` same as the old single-root behavior. A root that matched
 *  *some* but not all of its query spans already carries `serverStatsStatus: 'ok'` from `applyRows`
 *  — left as-is; its still-unmatched query spans are what Waterfall.tsx's pendingHint's "no server
 *  stats matched this query" branch (see B5) explains individually, since "ok" here correctly means
 *  "this action did get real data," just not for every one of its queries. */
function finalizeRemaining(): void {
  for (const { root, matchedSpanIds } of pending.values()) {
    if (matchedSpanIds.size === 0) {
      setSpanAttrs(root, { serverStatsStatus: 'no-data' });
    }
  }
  pending.clear();
}

function applyRowToSpan(span: Span, row: ServerStatsRow): void {
  setSpanAttrs(span, {
    serverQueryId: row.queryId,
    serverDurationMs: row.queryDurationMs,
    serverReadRows: row.readRows,
    serverReadBytes: row.readBytes,
    serverResultRows: row.resultRows,
    serverMemoryUsage: row.memoryUsage,
    ...(row.selectedMarks != null ? { serverSelectedMarks: row.selectedMarks } : {}),
    ...(row.selectedParts != null ? { serverSelectedParts: row.selectedParts } : {}),
    ...(row.selectedRanges != null ? { serverSelectedRanges: row.selectedRanges } : {}),
    ...(row.osReadBytes != null ? { serverOsReadBytes: row.osReadBytes } : {}),
    ...(row.exceptionCode ? { serverExceptionCode: row.exceptionCode } : {}),
    ...(row.exception ? { serverException: row.exception } : {}),
  });
  addTransportClickhouseSplit(span, row);
}

/**
 * Reconstructs the plan's `transport` / `clickhouse` breakdown (see the diagnostics plan's "The
 * model" section) now that a real `query_duration_ms` has arrived. Not measured live — ClickHouse
 * only tells us its own execution time after the fact, seconds later — so this is inferred from
 * the query span's own already-measured [start, end] window:
 *
 *   [ span.startMs ─────────────── decodeStart ]
 *   [── transport ──][── clickhouse ──]  (decode is its own real child, added in runQuery.ts)
 *
 * `clickhouse` is placed immediately before decode starts (a network response has to fully arrive
 * before decode can begin), sized to `query_duration_ms`, clamped to the window so a clock-skew
 * overshoot can't produce a negative `transport`. Whatever's left at the front is `transport` —
 * proxy + network time on both legs, not separately split (this plugin has no instrumentation
 * point between "sent" and "received" to split it further).
 */
function addTransportClickhouseSplit(span: Span, row: ServerStatsRow): void {
  if (span.endMs == null || row.queryDurationMs <= 0) {
    return;
  }
  // Already reconstructed for this span (e.g. a second enrichment pass) — never double up.
  if (span.children.some((c) => c.kind === 'clickhouse')) {
    return;
  }
  const decodeSpan = span.children.find((c) => c.kind === 'decode');
  const preDecodeEnd = decodeSpan ? decodeSpan.startMs : span.endMs;
  const windowMs = preDecodeEnd - span.startMs;
  if (windowMs <= 0) {
    return;
  }
  const clickhouseMs = Math.min(row.queryDurationMs, windowMs);
  const clickhouseStart = preDecodeEnd - clickhouseMs;

  if (clickhouseStart > span.startMs) {
    addHistoricalChild(span, 'transport', 'transport', span.startMs, clickhouseStart, 'ok');
  }
  addHistoricalChild(span, 'clickhouse', 'clickhouse', clickhouseStart, preDecodeEnd, 'ok', {
    readRows: row.readRows,
    readBytes: row.readBytes,
    resultRows: row.resultRows,
    memoryUsage: row.memoryUsage,
    ...(row.selectedMarks != null ? { selectedMarks: row.selectedMarks } : {}),
    ...(row.selectedParts != null ? { selectedParts: row.selectedParts } : {}),
  });
}

/** Test-only: allows a fresh subscription in the next test file. */
export function __resetForTests(): void {
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  activeController?.abort();
  activeController = null;
  pending = new Map();
  started = false;
  disposed = true;
}

