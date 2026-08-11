/**
 * KQL abstract syntax tree node types.
 */

export type KqlNode = KqlAnd | KqlOr | KqlNot | KqlIs | KqlRange;

export interface KqlAnd {
  type: 'and';
  left: KqlNode;
  right: KqlNode;
}

export interface KqlOr {
  type: 'or';
  left: KqlNode;
  right: KqlNode;
}

export interface KqlNot {
  type: 'not';
  operand: KqlNode;
}

/**
 * A field:value or bare-term match.
 *
 * field    – null means bare term (no field specified) → body free-text search.
 * isPhrase – value came from a "double-quoted string".
 * isWildcard – value contains an unescaped * wildcard.
 * isExists – field:*  →  "field exists in any form".
 * raw      – original `field:value` source text (set only for a simple field:value
 *            FieldExpr — not value-lists or ranges). Used by kqlIsToSql to fall back to a
 *            plain-text body search when `field` doesn't resolve to a real column, instead of
 *            emitting a direct (and likely broken) column reference — e.g. `http://x` parses as
 *            field "http", value "//x", but neither is a real field, so the whole `raw` text is
 *            searched instead.
 */
export interface KqlIs {
  type: 'is';
  field: string | null;
  value: string;
  isPhrase: boolean;
  isWildcard: boolean;
  isExists: boolean;
  raw?: string;
}

/**
 * A numeric / date range expression: field >= value, field < value, etc.
 */
export interface KqlRange {
  type: 'range';
  field: string;
  op: 'gt' | 'gte' | 'lt' | 'lte';
  value: string;
}
