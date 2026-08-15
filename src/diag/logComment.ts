/**
 * Correlation tag embedded in every ClickHouse query's `log_comment` setting when enrichment is
 * on — see diag/enrichment.ts's toggle and diag/serverStats.ts's lookup, which reads this back out
 * of `system.query_log`. Delimited, not JSON: `system.query_log` rows get filtered with
 * `startsWith(log_comment, …)` over a time+date-bounded window before any per-row parsing happens,
 * so the tag format only needs to be cheap to build here and cheap to split there —
 * `JSONExtractString` would parse JSON on every surviving row for no benefit over `splitByChar`.
 */

import { stripLiterals } from './sqlIntegrity';

const TAG_PREFIX = 'chobs';

/** Builds the tag for one query span — `chobs|<traceId>|<spanId>|<op>`. `traceId` is a span's
 *  `rootId` (see diag/types.ts), so every query under one action shares the same prefix and a
 *  single `startsWith` lookup finds them all. */
export function buildLogCommentTag(traceId: string, spanId: string, op: string): string {
  return [TAG_PREFIX, traceId, spanId, op].join('|');
}

/** The `startsWith(...)` prefix that matches every query tagged under one trace (action). */
export function logCommentPrefixForTrace(traceId: string): string {
  return `${TAG_PREFIX}|${traceId}|`;
}

const TRAILING_SETTINGS_RE = /^\s*SETTINGS\b/i;
const SETTINGS_WORD_RE = /\bSETTINGS\b/i;

/**
 * Appends `log_comment = '<tag>'` to a query's SETTINGS clause — or adds one if it has none (raw
 * SQL mode never goes through sql/settings.ts's withSettings, so it never has one). Only ever
 * matches a SETTINGS clause on the query's own last line, which is how every builder in this
 * codebase emits one (see settings.ts's withSettings) — deliberately not a bare substring search
 * for "SETTINGS" anywhere in the text, since raw-SQL mode is arbitrary user SQL that could contain
 * that word in a comment or string literal without it being a real trailing clause.
 *
 * If the query already carries a SETTINGS clause that *isn't* simply "starts on the last line" —
 * e.g. raw SQL mode with a clause wrapped across multiple lines, continuation-indented past the
 * `SETTINGS` keyword itself — appending a second `SETTINGS` clause here would be a ClickHouse
 * syntax error, and safely merging into an unknown-shaped existing clause needs real SQL parsing
 * this module doesn't have. `stripLiterals` first, so the check can't be fooled by the word
 * appearing inside a comment or string literal (see the test for exactly that case). Detected this
 * way: skip tagging entirely rather than risk emitting invalid SQL — the query just runs one
 * action untagged, which only costs that action's diagnostics detail, not correctness.
 */
export function appendLogComment(sql: string, tag: string): string {
  const fragment = `log_comment = '${tag.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  let trimmed = sql.trimEnd();
  if (trimmed.endsWith(';')) {
    trimmed = trimmed.slice(0, -1).trimEnd();
  }
  const lines = trimmed.split('\n');
  const lastLine = lines[lines.length - 1];
  if (TRAILING_SETTINGS_RE.test(lastLine)) {
    lines[lines.length - 1] = `${lastLine}, ${fragment}`;
    return lines.join('\n');
  }
  if (SETTINGS_WORD_RE.test(stripLiterals(trimmed))) {
    return sql;
  }
  return `${trimmed}\nSETTINGS ${fragment}`;
}
