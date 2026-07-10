/**
 * Translate a KQL AST node into a ClickHouse WHERE clause fragment.
 *
 * Reuses existing helpers from the parent sql/ package:
 *   resolveField                     (../fields)
 *   quoteString / quoteIdentifier    (../queryBuilder)
 */

import { KqlNode, KqlIs, KqlRange } from './ast';
import { WILDCARD_STAR, WILDCARD_QMARK } from './_lexer';
import { SourceConfig } from '../../types';
import { resolveField, FieldIndex } from '../fields';
import { quoteString, quoteIdentifier } from '../queryBuilder';

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
  // Unknown field: use the field name as a direct column rather than silently
  // falling back to body search, which produces wrong results for named-field queries.
  // e.g. `level:info` with severity unmapped → `"level" = 'info'`, not body ILIKE.
  const { sqlExpr, kind } = resolved ?? { sqlExpr: node.field, kind: 'exact' as const };
  const val = node.value;

  // Wildcard — applies to all field kinds (text, exact, map).
  // Check before isPhrase so "err*" with quotes can't override.
  if (node.isWildcard) {
    return `${maybeQuote(sqlExpr)} ILIKE ${quoteString(wildcardLike(val))}`;
  }

  // Phrase — behavior is field-kind-dependent:
  //   text  → word-boundary match() (full-text semantics)
  //   exact / map → exact equality (keyword-field semantics, quotes = precision)
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

  // Unquoted exact / map column → equality.
  return `${maybeQuote(sqlExpr)} = ${quoteString(val)}`;
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
  // hasToken for full-word match + ILIKE as fallback for substrings.
  return `(hasToken(${bodyCol}, ${quoteString(value)}) OR ${bodyCol} ILIKE ${quoteString('%' + escapeLike(value) + '%')})`;
}

/**
 * Escape ILIKE metacharacters in a literal value so user input matches exactly.
 * Must be called BEFORE wildcardLike() — wildcard sentinels are unaffected
 * because WILDCARD_STAR / WILDCARD_QMARK are not %, _, or \.
 *
 * The resulting string will be passed to quoteString(), which doubles backslashes,
 * so the SQL value `\%` (escaped percent) is reached via:
 *   escapeLike('%') → '\%' (JS: backslash + percent)
 *   quoteString('\%') → SQL '\\%'    ← ClickHouse reads \\ as \, so pattern is \%
 *   ClickHouse ILIKE \% → literal %
 */
function escapeLike(value: string): string {
  return value
    .replace(/\\/g, '\\\\')  // escape backslash first (must be first!)
    .replace(/%/g, '\\%')    // literal % → not an ILIKE wildcard
    .replace(/_/g, '\\_');   // literal _ → not an ILIKE single-char wildcard
}

/**
 * Convert a wildcard IDENT value (containing sentinels) to an ILIKE pattern.
 * Escapes literal %, _, \ first, then substitutes sentinels with % and _.
 */
function wildcardLike(value: string): string {
  return escapeLike(value)
    .replace(new RegExp(WILDCARD_STAR, 'g'), '%')
    .replace(new RegExp(WILDCARD_QMARK, 'g'), '_');
}

/**
 * Generates a ClickHouse match() call with word-boundary assertions.
 * Uses [^a-zA-Z0-9_] instead of \W to avoid backslash-escaping ambiguity
 * in SQL string literals.
 * Prevents "req-59" from matching "req-592".
 */
function phraseMatch(col: string, value: string): string {
  const escaped = escapeRe2(value);
  return `match(${col}, '(?i)(^|[^a-zA-Z0-9_])${escaped}([^a-zA-Z0-9_]|$)')`;
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
