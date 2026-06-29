/**
 * Translate a KQL AST node into a ClickHouse WHERE clause fragment.
 *
 * Reuses existing helpers from the parent sql/ package:
 *   resolveField / buildLevelClause  (../fields)
 *   quoteString / quoteIdentifier    (../queryBuilder)
 */

import { KqlNode, KqlIs, KqlRange } from './ast';
import { SourceConfig } from '../../types';
import { resolveField, buildLevelClause } from '../fields';
import { quoteString, quoteIdentifier } from '../queryBuilder';

export function kqlToSql(node: KqlNode, config: SourceConfig): string {
  switch (node.type) {
    case 'and':
      return `(${kqlToSql(node.left, config)}) AND (${kqlToSql(node.right, config)})`;
    case 'or':
      return `(${kqlToSql(node.left, config)}) OR (${kqlToSql(node.right, config)})`;
    case 'not':
      return `NOT (${kqlToSql(node.operand, config)})`;
    case 'is':
      return kqlIsToSql(node, config);
    case 'range':
      return kqlRangeToSql(node, config);
  }
}

// ── is ────────────────────────────────────────────────────────────────────────

function kqlIsToSql(node: KqlIs, config: SourceConfig): string {
  const bodyCol = config.columns.body;

  // ── Bare term (no field) → body search ──────────────────────────────────
  if (node.field === null) {
    return bareTermSql(bodyCol, node.value, node.isPhrase);
  }

  // ── Exists: field:* ──────────────────────────────────────────────────────
  if (node.isExists) {
    const resolved = resolveField(node.field, config);
    const expr = resolved?.sqlExpr ?? fallbackMapExpr(node.field, config);
    // notEmpty(toString(expr)) works for String, Map, numeric, etc.
    return `notEmpty(toString(${maybeQuote(expr)}))`;
  }

  // ── Named field ──────────────────────────────────────────────────────────
  const resolved = resolveField(node.field, config);
  if (!resolved) {
    // Unknown field: fall back to body search
    return bareTermSql(bodyCol, node.value, node.isPhrase);
  }

  const { sqlExpr, kind } = resolved;
  const val = node.value;

  if (kind === 'level') {
    return buildLevelClause(sqlExpr, val, false);
  }

  // Phrase or text-typed column → ILIKE '%val%'
  if (kind === 'text' || node.isPhrase) {
    return `${maybeQuote(sqlExpr)} ILIKE ${quoteString('%' + val + '%')}`;
  }

  // Wildcard → ILIKE with * → % and ? → _
  if (node.isWildcard) {
    const pattern = val.replace(/\*/g, '%').replace(/\?/g, '_');
    return `${maybeQuote(sqlExpr)} ILIKE ${quoteString(pattern)}`;
  }

  return `${maybeQuote(sqlExpr)} = ${quoteString(val)}`;
}

// ── range ─────────────────────────────────────────────────────────────────────

const OP_MAP: Record<string, string> = {
  gt: '>', gte: '>=', lt: '<', lte: '<=',
};

function kqlRangeToSql(node: KqlRange, config: SourceConfig): string {
  const resolved = resolveField(node.field, config);
  if (!resolved) {
    return '1=1'; // unknown field — ignore range rather than crashing
  }
  const { sqlExpr } = resolved;
  const op = OP_MAP[node.op];
  // Use numeric literal if the value looks like a number, otherwise quote it.
  const numVal = Number(node.value);
  const sqlVal = Number.isFinite(numVal) && node.value.trim() !== ''
    ? String(numVal)
    : quoteString(node.value);
  return `${maybeQuote(sqlExpr)} ${op} ${sqlVal}`;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function bareTermSql(bodyCol: string, value: string, isPhrase: boolean): string {
  if (isPhrase) {
    return `${bodyCol} ILIKE ${quoteString('%' + value + '%')}`;
  }
  // hasToken for full-word match + ILIKE as fallback (matches existing behaviour)
  return `(hasToken(${bodyCol}, ${quoteString(value)}) OR ${bodyCol} ILIKE ${quoteString('%' + value + '%')})`;
}

/**
 * Quote a SQL expression only if it doesn't already contain special characters
 * that indicate it's already a complex expression (map accessor, function call, etc.).
 */
function maybeQuote(expr: string): string {
  return quoteIdentifier(expr);
}

/** Build a map-attribute accessor for an unknown field. */
function fallbackMapExpr(field: string, config: SourceConfig): string {
  const mapCol = config.columns.logAttributes || config.columns.resourceAttributes;
  return mapCol ? `${mapCol}['${field}']` : field;
}
