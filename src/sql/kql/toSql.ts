/**
 * Translate a KQL AST node into a ClickHouse WHERE clause fragment.
 *
 * Reuses existing helpers from the parent sql/ package:
 *   resolveField                     (../fields)
 *   quoteString / quoteIdentifier / escapeLike (../queryBuilder)
 */

import { KqlNode, KqlIs, KqlRange } from './ast';
import { WILDCARD_STAR, WILDCARD_RE } from './_lexer';
import { SourceConfig } from '../../types';
import { resolveField, FieldIndex, FieldKind } from '../fields';
import { FieldModel } from '../fieldModel';
import { quoteString, quoteIdentifier, escapeLike } from '../queryBuilder';

export function kqlToSql(node: KqlNode, config: SourceConfig, index?: FieldIndex): string {
  switch (node.type) {
    case 'and':
      return `(${kqlToSql(node.left, config, index)}) AND (${kqlToSql(node.right, config, index)})`;
    case 'or':
      return `(${kqlToSql(node.left, config, index)}) OR (${kqlToSql(node.right, config, index)})`;
    case 'not': {
      const inner = kqlToSql(node.operand, config, index);
      // '1=1' is a no-op sentinel (unresolvable field) — negating it would
      // wrongly turn "ignore this clause" into "exclude everything".
      return inner === '1=1' ? '1=1' : `NOT (${inner})`;
    }
    case 'is':
      return kqlIsToSql(node, config, index);
    case 'range':
      return kqlRangeToSql(node, config, index);
  }
}

// ── is ────────────────────────────────────────────────────────────────────────

function kqlIsToSql(node: KqlIs, config: SourceConfig, index?: FieldIndex): string {
  const bodyCol = config.columns.body;

  // ── Bare term (no field) → body search ──────────────────────────────────
  if (node.field === null) {
    if (!bodyCol) {
      return '1=1'; // body column not mapped — ignore bare terms rather than emit broken SQL
    }
    return bareTermSql(bodyCol, node.value, node.isWildcard, node.isPhrase);
  }

  // ── Field-name wildcard: data*: 5 / datastream.*: logs — matches KQL, which lets a wildcard
  // stand in for the field too. Only expandable against real discovered fields (`index`); without
  // one this falls through to the ordinary unresolved-field handling below.
  if (index && WILDCARD_RE.test(node.field)) {
    return fieldWildcardSql(node, node.field, config, index);
  }

  // ── Exists: field:* ──────────────────────────────────────────────────────
  if (node.isExists) {
    const resolved = resolveField(node.field, config, index);
    // Unresolved → direct column reference, same fallback kqlIsToSql/kqlRangeToSql use below.
    const expr = resolved?.sqlExpr ?? node.field;
    // notEmpty(toString(expr)) works for String, Map, JSON, numeric, etc.
    return `notEmpty(toString(${maybeQuote(expr)}))`;
  }

  // ── Named field ──────────────────────────────────────────────────────────
  const resolved = resolveField(node.field, config, index);

  if (resolved === null) {
    // Unknown field. With `index` present — real discovered columns were threaded through, so
    // "unresolved" genuinely means "not a column" — fall back to a plain-text body search over
    // the original `field:value` text instead of emitting a broken direct-column reference
    // (`"http" = '//x'` from typing `http://x` → ClickHouse "Unknown identifier" error).
    // Without an index (e.g. dashboard-panel export, which doesn't thread field discovery
    // through — see fields.ts:56-59) keep the historical direct-column fallback so that caller
    // doesn't silently regress into body-only search.
    if (index && node.raw !== undefined) {
      if (!bodyCol) {
        return '1=1';
      }
      return bareTermSql(bodyCol, node.raw, WILDCARD_RE.test(node.raw), false);
    }
    return valueSql(node, node.field, 'exact');
  }

  return valueSql(node, resolved.sqlExpr, resolved.kind);
}

/**
 * Emit the SQL for a resolved (or direct-column-fallback) field + value, shared by the normal
 * path and field-wildcard expansion below — both need the same wildcard/phrase/typed-literal
 * handling per matched column.
 */
function valueSql(node: KqlIs, sqlExpr: string, kind: FieldKind): string {
  const val = node.value;

  // Wildcard — applies to all field kinds (text, exact, map).
  // Check before isPhrase so "err*" with quotes can't override.
  if (node.isWildcard) {
    return `${maybeQuote(sqlExpr)} ILIKE ${quoteString(wildcardLike(val))}`;
  }

  // Phrase — behavior is field-kind-dependent:
  //   text  → word-boundary match() (full-text semantics)
  //   exact / map → exact equality (keyword-field semantics, quotes = precision; quoted values
  //                 are never typed as true/false/null — QuotedString always stays a string)
  if (node.isPhrase) {
    if (kind === 'text') {
      return phraseMatch(maybeQuote(sqlExpr), val);
    }
    return `${maybeQuote(sqlExpr)} = ${quoteString(val)}`;
  }

  // Unquoted text column → substring contains (full-text behaviour).
  if (kind === 'text') {
    return `${maybeQuote(sqlExpr)} ILIKE ${quoteString('%' + escapeLike(val) + '%')}`;
  }

  // Unquoted exact / map / json column → equality, with true/false/null typed literals (the KQL
  // grammar's UnquotedLiteral converts these three exact-case sequences to typed nodes rather
  // than strings).
  return equalsSql(maybeQuote(sqlExpr), val);
}

function equalsSql(sqlExpr: string, value: string): string {
  if (value === 'true')  { return `${sqlExpr} = true`;  }
  if (value === 'false') { return `${sqlExpr} = false`; }
  if (value === 'null')  { return `${sqlExpr} IS NULL`; }
  return `${sqlExpr} = ${quoteString(value)}`;
}

/**
 * `data*: 5` / `datastream.*: logs` — the field position itself carries a wildcard sentinel.
 * Expand it against every discovered field (`index`) whose name/displayName/sqlExpr matches, and
 * OR the per-field clause together — mirrors Elasticsearch matching the value across every field
 * the wildcard covers. No matches → 1=0 (matches nothing; NOT of it correctly matches everything).
 */
function fieldWildcardSql(node: KqlIs, field: string, config: SourceConfig, index: FieldIndex): string {
  const pattern = wildcardFieldRegex(field);
  const matched = new Map<string, FieldModel>(); // dedupe by sqlExpr
  for (const f of index.byName.values()) {
    if (pattern.test(f.name) || pattern.test(f.displayName)) {
      matched.set(f.sqlExpr, f);
    }
  }
  if (matched.size === 0) {
    return '1=0';
  }
  const clauses = Array.from(matched.values()).map((f) => {
    if (node.isExists) {
      return `notEmpty(toString(${maybeQuote(f.sqlExpr)}))`;
    }
    const resolved = resolveField(f.sqlExpr, config, index);
    return valueSql(node, f.sqlExpr, resolved?.kind ?? 'exact');
  });
  return clauses.length === 1 ? clauses[0] : clauses.map((c) => `(${c})`).join(' OR ');
}

/** Convert a field name containing WILDCARD_STAR sentinels into a case-insensitive regex. */
function wildcardFieldRegex(fieldWithSentinel: string): RegExp {
  const escaped = fieldWithSentinel
    .split(WILDCARD_STAR)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + escaped + '$', 'i');
}

// ── range ─────────────────────────────────────────────────────────────────────

const OP_MAP: Record<string, string> = {
  gt: '>', gte: '>=', lt: '<', lte: '<=',
};

function kqlRangeToSql(node: KqlRange, config: SourceConfig, index?: FieldIndex): string {
  const resolved = resolveField(node.field, config, index);
  // Unknown field: use the field name as a direct column, same as kqlIsToSql.
  const { sqlExpr, kind } = resolved ?? { sqlExpr: node.field, kind: 'exact' as const };
  const op = OP_MAP[node.op];
  const numVal = Number(node.value);
  const isNumeric = Number.isFinite(numVal) && node.value.trim() !== '';
  const sqlVal = isNumeric ? String(numVal) : quoteString(node.value);
  // Map attribute values are always String in ClickHouse, and a JSON path's dynamic value isn't
  // guaranteed to compare correctly against a numeric literal either. For numeric range
  // comparisons on either kind, cast to Float64 so the comparison works correctly.
  // (e.g. LogAttributes['response_time_ms'] > 1000 would fail without cast.)
  const lhs = ((kind === 'map' || kind === 'json') && isNumeric)
    ? `toFloat64(${maybeQuote(sqlExpr)})`
    : maybeQuote(sqlExpr);
  return `${lhs} ${op} ${sqlVal}`;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function bareTermSql(bodyCol: string, value: string, isWildcard: boolean, isPhrase: boolean): string {
  if (isWildcard) {
    // Bare wildcard e.g. pay* → prefix/suffix/infix on body
    return `${bodyCol} ILIKE ${quoteString(wildcardLike(value))}`;
  }
  if (isPhrase) {
    return phraseMatch(bodyCol, value);
  }
  // No hasToken() here — it throws BAD_ARGUMENTS on any needle containing a separator character
  // (`-`, `.`, `:`, `/`, space — all common in log search terms like "req-59" or "1.2.3.4"), and is
  // redundant even when it doesn't throw: everything a case-sensitive whole-token hasToken() match
  // can find, the case-insensitive substring ILIKE below already finds too. See C3 in the audit plan.
  return `${bodyCol} ILIKE ${quoteString('%' + escapeLike(value) + '%')}`;
}

/**
 * Convert a wildcard IDENT value (containing sentinels) to an ILIKE pattern.
 * Escapes literal %, _, \ first, then substitutes the wildcard sentinel with %.
 */
function wildcardLike(value: string): string {
  return escapeLike(value).replace(new RegExp(WILDCARD_STAR, 'g'), '%');
}

/**
 * Generates a ClickHouse match() call with word-boundary assertions.
 * Uses [^a-zA-Z0-9_] instead of \W to avoid backslash-escaping ambiguity
 * in SQL string literals.
 * Prevents "req-59" from matching "req-592".
 *
 * The regex pattern is built in plain JS and passed through quoteString() — same as any other
 * SQL string literal — so a literal ' in the search text (e.g. Body:"it's fine") can't break out
 * of the string, and regex escapes survive ClickHouse's own string-literal unescaping (quoteString
 * doubles backslashes, so `\.` in the source pattern arrives as `\\.` in SQL, which ClickHouse
 * reads back as `\.` — a literal-dot escape for re2 — instead of collapsing to a bare `.`).
 */
function phraseMatch(col: string, value: string): string {
  const pattern = `(?i)(^|[^a-zA-Z0-9_])${escapeRe2(value)}([^a-zA-Z0-9_]|$)`;
  return `match(${col}, ${quoteString(pattern)})`;
}

/** Escape re2 metacharacters within a literal string segment. */
function escapeRe2(s: string): string {
  return s.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Quote a SQL expression only if it doesn't already contain special characters
 * that indicate it's already a complex expression (map accessor, function call, etc.).
 */
function maybeQuote(expr: string): string {
  return quoteIdentifier(expr);
}
