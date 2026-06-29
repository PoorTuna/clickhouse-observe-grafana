/**
 * KQL recursive-descent parser.
 *
 * Grammar (mirrors Kibana's kuery/grammar/grammar.peggy):
 *
 *   OrQuery      → AndQuery ('or'  AndQuery)*
 *   AndQuery     → NotQuery ('and' NotQuery)*
 *   NotQuery     → 'not' NotQuery | SubQuery
 *   SubQuery     → '(' OrQuery ')' | Expression
 *   Expression   → RangeExpr | FieldExpr | BareTermExpr
 *   RangeExpr    → IDENT ('>=' | '<=' | '>' | '<') Value
 *   FieldExpr    → IDENT ':' ('*' | '(' ValueList ')' | Value)
 *   BareTermExpr → QUOTED | IDENT
 *   ValueList    → ValueListItem (('and'|'or') ValueListItem)*
 *   ValueListItem→ ('not')? Value
 *   Value        → QUOTED | IDENT
 *
 * Throws a string message on parse errors; callers fall back to body search.
 */

import { lex, Token } from './_lexer';
import { KqlNode, KqlAnd, KqlOr, KqlNot, KqlIs, KqlRange } from './ast';

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = lex(input);
  }

  parse(): KqlNode {
    const node = this.parseOr();
    if (this.peek().type !== 'EOF') {
      // Implicit AND with anything that follows (lenient — matches Kibana behaviour for
      // space-separated terms even without an explicit "and").
      return this.foldAnd(node);
    }
    return node;
  }

  // ── Grammar rules ────────────────────────────────────────────────────────

  private parseOr(): KqlNode {
    let left = this.parseAnd();
    while (this.peek().type === 'OR') {
      this.consume();
      const right = this.parseAnd();
      const node: KqlOr = { type: 'or', left, right };
      left = node;
    }
    return left;
  }

  private parseAnd(): KqlNode {
    let left = this.parseNot();
    while (this.peek().type === 'AND') {
      this.consume();
      const right = this.parseNot();
      const node: KqlAnd = { type: 'and', left, right };
      left = node;
    }
    return left;
  }

  private parseNot(): KqlNode {
    if (this.peek().type === 'NOT') {
      this.consume();
      const operand = this.parseNot();
      const node: KqlNot = { type: 'not', operand };
      return node;
    }
    return this.parseSubQuery();
  }

  private parseSubQuery(): KqlNode {
    if (this.peek().type === 'LPAREN') {
      this.consume();
      const node = this.parseOr();
      this.expect('RPAREN');
      return node;
    }
    return this.parseExpression();
  }

  private parseExpression(): KqlNode {
    // Range: IDENT (>= | <= | > | <) value
    if (
      this.peek().type === 'IDENT' &&
      ['GT', 'GTE', 'LT', 'LTE'].includes(this.peek2().type)
    ) {
      const field = this.consume().value;
      const opTok = this.consume();
      const val = this.consumeValue();
      const opMap: Record<string, 'gt' | 'gte' | 'lt' | 'lte'> = {
        GT: 'gt', GTE: 'gte', LT: 'lt', LTE: 'lte',
      };
      const node: KqlRange = { type: 'range', field, op: opMap[opTok.type], value: val.value };
      return node;
    }

    // Field expression: IDENT ':'
    if (this.peek().type === 'IDENT' && this.peek2().type === 'COLON') {
      return this.parseFieldExpr();
    }

    // Bare term (phrase or unquoted word)
    const val = this.consumeValue();
    const node: KqlIs = {
      type: 'is',
      field: null,
      value: val.value,
      isPhrase: val.isPhrase,
      isWildcard: !val.isPhrase && /[*?]/.test(val.value),
      isExists: false,
    };
    return node;
  }

  private parseFieldExpr(): KqlNode {
    const field = this.consume().value; // IDENT
    this.consume(); // COLON

    // field:*  → exists
    if (this.peek().type === 'IDENT' && this.peek().value === '*') {
      this.consume();
      const node: KqlIs = {
        type: 'is', field,
        value: '*', isPhrase: false, isWildcard: false, isExists: true,
      };
      return node;
    }

    // field:(valueList)
    if (this.peek().type === 'LPAREN') {
      this.consume();
      const node = this.parseValueList(field);
      this.expect('RPAREN');
      return node;
    }

    // field:value
    const val = this.consumeValue();
    const node: KqlIs = {
      type: 'is', field,
      value: val.value,
      isPhrase: val.isPhrase,
      isWildcard: !val.isPhrase && /[*?]/.test(val.value),
      isExists: false,
    };
    return node;
  }

  private parseValueList(field: string): KqlNode {
    let left = this.parseValueListItem(field);
    while (this.peek().type === 'AND' || this.peek().type === 'OR') {
      const isAnd = this.consume().type === 'AND';
      const right = this.parseValueListItem(field);
      left = isAnd
        ? ({ type: 'and', left, right } as KqlAnd)
        : ({ type: 'or', left, right } as KqlOr);
    }
    return left;
  }

  private parseValueListItem(field: string): KqlNode {
    const negate = this.peek().type === 'NOT';
    if (negate) {
      this.consume();
    }
    const val = this.consumeValue();
    const is: KqlIs = {
      type: 'is', field,
      value: val.value,
      isPhrase: val.isPhrase,
      isWildcard: !val.isPhrase && /[*?]/.test(val.value),
      isExists: false,
    };
    return negate ? ({ type: 'not', operand: is } as KqlNot) : is;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private consumeValue(): { value: string; isPhrase: boolean } {
    const t = this.peek();
    if (t.type === 'QUOTED') {
      this.consume();
      return { value: t.value, isPhrase: true };
    }
    if (t.type === 'IDENT') {
      this.consume();
      return { value: t.value, isPhrase: false };
    }
    throw new Error(`Expected value at position ${t.start}, got ${t.type}`);
  }

  /** After top-level parse, fold any remaining non-OR/non-EOF tokens as implicit AND. */
  private foldAnd(left: KqlNode): KqlNode {
    while (this.peek().type !== 'EOF' && this.peek().type !== 'RPAREN') {
      if (this.peek().type === 'OR') {
        break;
      }
      // skip explicit AND keyword if present
      if (this.peek().type === 'AND') {
        this.consume();
      }
      let right: KqlNode;
      try {
        right = this.parseNot();
      } catch {
        break;
      }
      const node: KqlAnd = { type: 'and', left, right };
      left = node;
    }
    return left;
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? { type: 'EOF', value: '', start: 0, end: 0 };
  }

  private peek2(): Token {
    return this.tokens[this.pos + 1] ?? { type: 'EOF', value: '', start: 0, end: 0 };
  }

  private consume(): Token {
    const t = this.peek();
    this.pos++;
    return t;
  }

  private expect(type: string): Token {
    const t = this.peek();
    if (t.type !== type) {
      throw new Error(`Expected ${type} at position ${t.start}, got ${t.type}`);
    }
    return this.consume();
  }
}

/** Parse a KQL string into an AST. Throws on parse errors. */
export function parseKql(input: string): KqlNode {
  return new Parser(input.trim()).parse();
}
