/**
 * Pure helpers for flattening a root Span's tree into renderable rows — shared by Waterfall.tsx
 * / QueryList.tsx (rendering) and warnings.ts (the integrity-check engine). Kept framework-free
 * so they're trivial to unit test without mounting anything.
 */
import { Span } from './types';

export interface FlatSpanRow {
  span: Span;
  depth: number;
}

/** Depth-first flatten, preserving the order children were created in. */
export function flattenSpanTree(root: Span): FlatSpanRow[] {
  const rows: FlatSpanRow[] = [];
  function visit(span: Span, depth: number): void {
    rows.push({ span, depth });
    for (const child of span.children) {
      visit(child, depth + 1);
    }
  }
  visit(root, 0);
  return rows;
}

/**
 * A "query" span is one runQuery.ts actually issued — identified by carrying `attrs.sql`, set in
 * fetchFrames() — as opposed to structural spans like the action root itself. Filtering on the
 * attrs' shape rather than `kind` keeps this correct even as more non-query phase kinds
 * ('build', 'transport', 'clickhouse', 'decode', 'render' — see diag/types.ts's SpanKind) are
 * added under a query span later without this list needing to be kept in sync.
 */
export function querySpans(root: Span): Span[] {
  return flattenSpanTree(root)
    .map((row) => row.span)
    .filter((span) => typeof span.attrs.sql === 'string');
}

/**
 * The latest `endMs` anywhere in `root`'s tree, `root.endMs` included — never just `root.endMs`
 * alone. A root can end (e.g. LogsExplorer.tsx's executeQuery closes the action once logs+volume
 * settle) before a child it caused finishes (the `render` span, closed on the next rAF after
 * commit) — see the diagnostics plan's B4 finding. A displayed "how long did this take" should
 * cover everything the action caused, not just the moment its own span happened to close, or the
 * number under-reports and any waterfall scaled to it clips its own last bar.
 *
 * Returns `null` while any span in the tree is still running (`endMs == null`) — "duration so far"
 * for a live tree is the caller's job (see useLiveNow), this only ever answers the finished case.
 */
export function treeEndMs(root: Span): number | null {
  let latest: number | null = null;
  for (const { span } of flattenSpanTree(root)) {
    if (span.endMs == null) {
      return null;
    }
    if (latest == null || span.endMs > latest) {
      latest = span.endMs;
    }
  }
  return latest;
}

/** True if any span anywhere in `root`'s tree is still `running` — not just the root itself. A
 *  child (e.g. a `render` span outliving the action that spawned it, see `treeEndMs`) can still be
 *  live under an already-ended root; a live-tick decision keyed on `root.status` alone would freeze
 *  that child's bar at a stale timestamp instead of growing it. */
export function hasRunningSpan(root: Span): boolean {
  return flattenSpanTree(root).some(({ span }) => span.status === 'running');
}
