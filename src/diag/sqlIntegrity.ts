/**
 * Pure text-level checks for the "confidently wrong, not just slow" failure class the diagnostics
 * plan's Phase 2.5 exists to catch — see queryBuilder.ts's VOLUME_QUERY_SETTINGS doc comment for
 * the incident this is all downstream of. Framework-free and dependency-free on purpose: these run
 * against whatever SQL text a query span already carries (see runQuery.ts's `sql`/`executedSql`
 * attrs), no ClickHouse round-trip required.
 */

/** First `LIMIT n` in a query, or undefined if the query has none. Deliberately just the row cap —
 *  `LIMIT n OFFSET m` and `LIMIT n` both match on the first number, and that's the only one
 *  relevant to "did this query get capped". */
export function extractLimit(sql: string): number | undefined {
  const match = /\bLIMIT\s+(\d+)/i.exec(sql);
  return match ? Number(match[1]) : undefined;
}

/**
 * Whether a query's result was capped by its own LIMIT — i.e. more rows likely exist than were
 * returned. Undefined (not false) when the query has no LIMIT at all, since "not truncated" and
 * "not applicable" are different facts a caller shouldn't conflate.
 */
export function detectTruncation(sql: string, rowCount: number): boolean | undefined {
  const limit = extractLimit(sql);
  if (limit == null) {
    return undefined;
  }
  return rowCount >= limit;
}

const OVERFLOW_BREAK_RE = /\b(timeout_overflow_mode|read_overflow_mode|result_overflow_mode)\s*=\s*'break'/i;
const GROUP_BY_ANY_RE = /\bgroup_by_overflow_mode\s*=\s*'any'/i;
const SAMPLE_RE = /\bSAMPLE\b/i;

export interface SqlIntegrityFinding {
  kind: 'overflowBreak' | 'groupByAny' | 'sample';
  message: string;
}

/** Every text-level integrity concern found in a single query's SQL — see the module doc comment. */
export function checkSqlIntegrity(sql: string): SqlIntegrityFinding[] {
  const findings: SqlIntegrityFinding[] = [];
  if (OVERFLOW_BREAK_RE.test(sql)) {
    findings.push({
      kind: 'overflowBreak',
      message:
        "an overflow_mode = 'break' setting is in effect — a scan/row/time cap truncates the " +
        'result silently instead of failing loudly.',
    });
  }
  if (GROUP_BY_ANY_RE.test(sql)) {
    findings.push({
      kind: 'groupByAny',
      message: "group_by_overflow_mode = 'any' is in effect — some groups can be silently dropped from aggregated results.",
    });
  }
  if (SAMPLE_RE.test(sql)) {
    findings.push({
      kind: 'sample',
      message: 'query uses SAMPLE — counts are scaled/estimated, not exact.',
    });
  }
  return findings;
}
