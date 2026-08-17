/**
 * Detects a coarse "prune column" — a partition/primary-key-member time column that is a
 * monotonic-non-decreasing, truncating function of the mapped (fine) timestamp column — so
 * buildWhereConditions/buildLogDetailQuery can add a second, redundant WHERE predicate on it
 * purely for MinMax/partition pruning (see queryBuilder.ts's doc comments on those call sites).
 *
 * Why this needs proof, not a name guess: two independently-ingested time columns (e.g. an
 * ingest-time column vs an event-time column) can diverge in either direction. Only a column that
 * is *provably* `coarse = f(fine)` with `f` monotonic non-decreasing is safe to filter on in
 * addition to the fine column — anything else risks silently dropping real rows. `system.columns`
 * reports a column's DEFAULT/MATERIALIZED expression verbatim (e.g. `toDate(Timestamp)`), which is
 * exactly that proof when it resolves to a whitelisted wrapper over the mapped timestamp column.
 */

export interface PruneCandidateColumn {
  name: string;
  /** Raw ClickHouse type string, e.g. "DateTime", "Date", "DateTime64(9)". */
  type: string;
  /** system.columns.default_kind — 'DEFAULT' | 'MATERIALIZED' | 'ALIAS' | '' (no default). */
  defaultKind: string;
  /** system.columns.default_expression — verbatim SQL text, e.g. "toDate(Timestamp)". */
  defaultExpression: string;
  isInPartitionKey: boolean;
  isInPrimaryKey: boolean;
  /** system.columns.position — used only to tie-break between otherwise-equal candidates. */
  position: number;
}

const TIME_TYPE_RE = /^(Date32?|DateTime|DateTime64)(\(.*\))?$/;

/** Wrappers whose output is provably monotonic non-decreasing and truncating over their single
 *  time-typed argument — each takes exactly the mapped timestamp column as its only "time" arg. */
const MONOTONIC_WRAPPERS = [
  'toDateTime',
  'toDate',
  'toStartOfSecond',
  'toStartOfMinute',
  'toStartOfHour',
  'toStartOfDay',
];

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';

/** Strips one optional outer `toTimeZone(<expr>, 'TZ')` wrapper, if present, returning the inner
 *  expression unchanged otherwise — toTimeZone is a relabeling, not a truncation, so it doesn't
 *  affect monotonicity and is safe to see through. */
function stripToTimeZone(expr: string): string {
  const m = expr.trim().match(/^toTimeZone\(\s*(.+?)\s*,\s*'[^']*'\s*\)$/);
  return m ? m[1].trim() : expr.trim();
}

/**
 * True when `defaultExpression` is exactly one of the whitelisted monotonic-non-decreasing
 * wrappers applied to `tsColumn` (optionally nested inside a single `toTimeZone(...)`).
 */
export function isMonotonicWrapperOf(defaultExpression: string, tsColumn: string): boolean {
  if (!defaultExpression || !tsColumn) {
    return false;
  }
  const inner = stripToTimeZone(defaultExpression);

  const dt64 = inner.match(new RegExp(`^toDateTime64\\(\\s*(${IDENT})\\s*,\\s*\\d+\\s*\\)$`));
  if (dt64) {
    return dt64[1] === tsColumn;
  }

  for (const fn of MONOTONIC_WRAPPERS) {
    const m = inner.match(new RegExp(`^${fn}\\(\\s*(${IDENT})\\s*\\)$`));
    if (m) {
      return m[1] === tsColumn;
    }
  }

  return false;
}

/**
 * Picks the best prune-column candidate for `mappedTimestamp`, or null when none qualifies (e.g.
 * the mapped timestamp is itself the sort key, as on `default.eval_otel`) — callers must emit
 * today's SQL unchanged in that case. Prefers a partition-key member over a primary-key-only one;
 * ties broken by `position` (lower wins), matching column declaration order.
 */
export function detectPruneColumn(
  columns: PruneCandidateColumn[],
  mappedTimestamp: string
): string | null {
  if (!mappedTimestamp) {
    return null;
  }

  const candidates = columns.filter(
    (c) =>
      c.name !== mappedTimestamp &&
      TIME_TYPE_RE.test(c.type) &&
      (c.isInPartitionKey || c.isInPrimaryKey) &&
      (c.defaultKind === 'DEFAULT' || c.defaultKind === 'MATERIALIZED') &&
      isMonotonicWrapperOf(c.defaultExpression, mappedTimestamp)
  );

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => {
    if (a.isInPartitionKey !== b.isInPartitionKey) {
      return a.isInPartitionKey ? -1 : 1;
    }
    return a.position - b.position;
  });

  return candidates[0].name;
}
