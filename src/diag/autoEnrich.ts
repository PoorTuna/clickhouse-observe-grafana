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
 */
import { SourceConfig } from '../types';
import { onRootEnd, setSpanAttrs } from './tracer';
import { fetchServerStats, ServerStatsRow } from './serverStats';
import { isEnrichmentEnabled } from './enrichment';
import { flattenSpanTree } from './spanTree';
import { Span } from './types';

export interface EnrichmentContext {
  datasourceUid: string;
  config: SourceConfig;
}

let started = false;

/** Idempotent — a second call just replaces the context getter, it never double-subscribes (App.tsx
 *  mounts once in practice, but React StrictMode's double-invoke in dev shouldn't double-enrich). */
export function startAutoEnrichment(getContext: () => EnrichmentContext | undefined): () => void {
  if (started) {
    return () => {};
  }
  started = true;
  return onRootEnd((root) => {
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
    void enrichRoot(root, ctx);
  });
}

async function enrichRoot(root: Span, ctx: EnrichmentContext): Promise<void> {
  // Distinct from the untouched/undefined state above: this root's queries WERE tagged and a
  // lookup is genuinely in flight. StatsTable renders this and "undefined" identically today (both
  // are "waiting"), but keeping them distinct in the data model means that UI split is a rendering
  // choice, not something the tracer needs to get right by omission.
  setSpanAttrs(root, { serverStatsStatus: 'pending' });
  const result = await fetchServerStats(ctx.datasourceUid, ctx.config, root.id);

  if (result.status !== 'ok') {
    setSpanAttrs(root, {
      serverStatsStatus: result.status,
      ...(result.status === 'unavailable' ? { serverStatsReason: result.reason, serverStatsDetail: result.detail } : {}),
    });
    return;
  }

  setSpanAttrs(root, { serverStatsStatus: 'ok' });
  const bySpanId = new Map(result.rows.map((row) => [row.spanId, row]));
  for (const { span } of flattenSpanTree(root)) {
    const row = bySpanId.get(span.id);
    if (row) {
      applyRowToSpan(span, row);
    }
  }
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
}

/** Test-only: allows a fresh subscription in the next test file. */
export function __resetForTests(): void {
  started = false;
}
