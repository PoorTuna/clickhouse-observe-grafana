/**
 * Pure text-level checks for the "confidently wrong, not just slow" failure class the diagnostics
 * plan's Phase 2.5 exists to catch — see queryBuilder.ts's VOLUME_QUERY_SETTINGS doc comment for
 * the incident this is all downstream of. Framework-free and dependency-free on purpose: these run
 * against whatever SQL text a query span already carries (see runQuery.ts's `sql`/`executedSql`
 * attrs), no ClickHouse round-trip required.
 */

// SETTINGS-clause keyword values kept as-is when stripping literals — a small, fixed,
// non-exhaustive set of ClickHouse enum values this codebase's own query builders emit (see
// sql/queryBuilder.ts, sql/settings.ts), never user-entered data. Keeping them is what lets
// `checkSqlIntegrity`'s overflow-mode checks below still find e.g. `timeout_overflow_mode =
// 'break'` after stripping — that literal is exactly the thing those checks look for, not user
// data to hide from them. diag/bundle.ts's redaction reuses this same list (via `stripLiterals`)
// so "safe to reveal" has one definition instead of two that can drift apart.
const SAFE_STRING_LITERALS = new Set(['throw', 'break', 'any', 'browser', 'dashboard', 'sql', 'Table']);
const STRING_LITERAL_RE = /'((?:[^'\\]|\\.)*)'/g;
const LINE_COMMENT_RE = /--[^\n]*/g;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;

/**
 * Replaces every string literal's contents (except the small keyword allowlist above) and every
 * comment with a placeholder. Two callers need this, for the same underlying reason — arbitrary
 * user-entered text (a searched value, a comment) must never be mistaken for SQL structure:
 *
 * 1. This module's own text-level checks (`checkSqlIntegrity`, `extractLimit`) — without it, a
 *    user searching for the literal word "sample" (`Body LIKE '%sample%'`) trips the SAMPLE
 *    finding, and a LIMIT number appearing inside a quoted string or a comment would be read as a
 *    real row cap. See the B8 finding.
 * 2. diag/bundle.ts's `redactSql` — the copy-bundle export's redaction pass, which is exactly the
 *    same "don't let user data read as something it isn't" concern, just for privacy instead of
 *    false positives. Kept here as the one definition both import, rather than two copies that can
 *    silently diverge on which values are "safe".
 */
export function stripLiterals(sql: string): string {
  return sql
    .replace(BLOCK_COMMENT_RE, ' ')
    .replace(LINE_COMMENT_RE, ' ')
    .replace(STRING_LITERAL_RE, (match, inner: string) => (SAFE_STRING_LITERALS.has(inner) ? match : `'<redacted>'`));
}

/** Last `LIMIT n` in a query, or undefined if the query has none. Deliberately just the row cap —
 *  `LIMIT n OFFSET m` and `LIMIT n` both match on the first number, and that's the only one
 *  relevant to "did this query get capped". The *last* occurrence, not the first: a query with a
 *  subquery (e.g. queryBuilder.ts's field-value sampler, which nests an inner `LIMIT sampleSize`
 *  before its own outer `LIMIT limit`) would otherwise report the inner subquery's cap as if it
 *  were the whole query's. Run against `stripLiterals`'d text so a LIMIT-shaped number inside a
 *  quoted string can't be mistaken for a real clause. */
export function extractLimit(sql: string): number | undefined {
  const matches = [...stripLiterals(sql).matchAll(/\bLIMIT\s+(\d+)/gi)];
  if (matches.length === 0) {
    return undefined;
  }
  return Number(matches[matches.length - 1][1]);
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

/** Every text-level integrity concern found in a single query's SQL — see the module doc comment.
 *  Runs against `stripLiterals`'d text so a searched value that happens to spell a keyword (e.g.
 *  `Body LIKE '%sample%'`) can't trip a finding meant to describe the query's own structure — see
 *  the B8 finding. The overflow-mode / group-by checks below are unaffected by this: their keyword
 *  values (`'break'`, `'any'`) are on `stripLiterals`'s own safe-to-keep allowlist. */
export function checkSqlIntegrity(rawSql: string): SqlIntegrityFinding[] {
  const sql = stripLiterals(rawSql);
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
