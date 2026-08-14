/**
 * Turns a root span's tree into the diagnostics drawer's Warnings tab entries — the "wrong, not
 * just slow" checks from the diagnostics plan's Phase 2.5. Two sources, both already available
 * client-side without needing Phase 2's ClickHouse-side enrichment:
 *
 * 1. Text-level SQL checks (diag/sqlIntegrity.ts) against every query span's SQL.
 * 2. Attrs a query span already carries — `truncated` (see runQuery.ts's runQueryRows) — plus its
 *    own `status`/`error`, since a span that failed is itself worth surfacing here even when the
 *    calling code (by design — see the plan's "Hole 2") never shows that failure in the page UI.
 *
 * A third source, added once Phase 2's server-side enrichment (diag/autoEnrich.ts) actually lands
 * data: a query span whose `serverExceptionCode` attr is set (ClickHouse recorded a real
 * exception) but whose own client-side `status` is `'ok'` — exactly the "exception recorded
 * server-side but not surfaced client-side" gap the plan's Phase 2.5 section named as needing
 * Phase 2's data to check.
 *
 * Deliberately NOT implemented here (see the plan's Phase 2.5 section for why): a histogram-vs-
 * grid-total cross-check and a partial-trailing-bucket flag. Both need data no phase of this plan
 * wires up (a true unbounded total count for the first; LogsExplorer-specific bucket/timeRange math
 * for the second) — left as a follow-up rather than shipped as a half-correct check that could
 * produce a false positive on a warnings surface, where trust is the entire point.
 */
import { Span } from './types';
import { flattenSpanTree, querySpans } from './spanTree';
import { checkSqlIntegrity } from './sqlIntegrity';

export type WarningSeverity = 'error' | 'warning' | 'info';

export interface Warning {
  id: string;
  spanId: string;
  spanName: string;
  severity: WarningSeverity;
  message: string;
}

/** Every warning-tab entry for `root`, most severe first (error > warning > info). */
export function computeWarnings(root: Span): Warning[] {
  const warnings: Warning[] = [];

  for (const span of querySpans(root)) {
    const sql = typeof span.attrs.executedSql === 'string' ? span.attrs.executedSql : (span.attrs.sql as string);
    for (const finding of checkSqlIntegrity(sql)) {
      warnings.push({
        id: `${span.id}:${finding.kind}`,
        spanId: span.id,
        spanName: span.name,
        severity: finding.kind === 'sample' ? 'info' : 'warning',
        message: `${span.name}: ${finding.message}`,
      });
    }
    if (span.attrs.truncated === true) {
      warnings.push({
        id: `${span.id}:truncated`,
        spanId: span.id,
        spanName: span.name,
        severity: 'info',
        message: `${span.name}: results were capped at the query's LIMIT — more rows likely exist than were returned.`,
      });
    }
    if (span.attrs.serverExceptionCode && span.status !== 'error') {
      const detail = typeof span.attrs.serverException === 'string' ? `: ${span.attrs.serverException}` : '';
      warnings.push({
        id: `${span.id}:serverException`,
        spanId: span.id,
        spanName: span.name,
        severity: 'error',
        message: `${span.name}: ClickHouse recorded an exception (code ${span.attrs.serverExceptionCode}) for this query that the page never surfaced as an error${detail}.`,
      });
    }
  }

  // Every failed span, including the ones LogsExplorer.tsx's own catch blocks deliberately swallow
  // (load-more, sidebar presence, the trace-link probe, field-value autocomplete — see the plan's
  // Hole 2) — this tab is what makes those visible again without changing their by-design silence
  // in the page UI itself.
  for (const { span } of flattenSpanTree(root)) {
    if (span.status === 'error') {
      warnings.push({
        id: `${span.id}:error`,
        spanId: span.id,
        spanName: span.name,
        severity: 'error',
        message: span.error ? `${span.name} failed: ${span.error}` : `${span.name} failed.`,
      });
    }
  }

  const rank: Record<WarningSeverity, number> = { error: 0, warning: 1, info: 2 };
  return warnings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
