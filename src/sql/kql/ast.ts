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
 * isWildcard – value contains unescaped * or ? wildcards.
 * isExists – field:*  →  "field exists in any form".
 */
export interface KqlIs {
  type: 'is';
  field: string | null;
  value: string;
  isPhrase: boolean;
  isWildcard: boolean;
  isExists: boolean;
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
