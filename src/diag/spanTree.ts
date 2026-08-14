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
