/**
 * KQL recursive-descent parser.
 *
 * Grammar (matches Elastic's kuery grammar.peggy — no implicit AND, whitespace is an ordinary
 * character inside a literal):
 *
 *   OrQuery      → AndQuery ('or'  AndQuery)*
 *   AndQuery     → NotQuery ('and' NotQuery)*
 *   NotQuery     → 'not' NotQuery | SubQuery
 *   SubQuery     → '(' OrQuery ')' | Expression
 *   Expression   → RangeExpr | FieldExpr | BareTermExpr
 *   RangeExpr    → IDENT ('>=' | '<=' | '>' | '<') Literal
 *   FieldExpr    → IDENT ':' ('*' | '(' ValueList ')' | Literal)
 *   BareTermExpr → Literal
 *   ValueList    → ValueListItem (('and'|'or') ValueListItem)*
 *   ValueListItem→ ('not')? Literal
 *   Literal      → QUOTED | greedy run of IDENT tokens (a "value" swallows spaces — it only ends
 *                  at and/or/not, a paren/brace, a quote, or the next `field:`/range operator)
 *
 * Throws KqlSyntaxError on parse errors (Kibana-style "Expected X but Y found" + caret) — callers
 * that need a query to always produce *something* (restored saved searches, dashboard export)
 * should catch it themselves; the live search bar (SearchBar.commit()) uses it to block a bad
 * query rather than silently searching the raw text.
 *
 * One known, deliberate gap from the real grammar: Elastic's `Field` production is the exact same
 * greedy Literal as `Value`, so e.g. "error service:pay" (no leading field on "error") technically
 * parses in Kibana as field "error service" = "pay" — a multi-word field name. This parser keeps
 * field names to a single IDENT token (decided when a FieldExpr is recognized, before any
 * absorption happens) and throws a syntax error on that input instead. Reproducing that exact PEG
 * backtracking would require deciding "field vs. bare term" only after seeing whether a colon
 * shows up several words later, which is a much larger change for an edge case nobody relies on —
 * throwing here is also the safer failure mode: that input is far more likely to be a forgotten
 * "and" than an intentional multi-word field name.
 */

import { lex, Token, TokType, WILDCARD_RE, WILDCARD_STAR } from './_lexer';
import { KqlNode, KqlAnd, KqlOr, KqlNot, KqlIs, KqlRange } from './ast';
import { KqlSyntaxError } from './_error';

/**
 * Token types that can never start or continue a plain Literal — used to bound greedy
 * absorption. COLON is included here even though consumeFieldValue() *does* let a value span a
 * ':' run (12:30:45) — that's handled explicitly by consumeFieldValue's own loop, which consumes
 * the COLON token itself; consumeLiteral()'s generic absorption must never swallow one, or a run
 * like "12:30:45" would eat the ':' as if it were ordinary IDENT continuation and end up with the
 * wrong split.
 */
const STOPS_LITERAL: TokType[] = [
  'EOF', 'AND', 'OR', 'NOT', 'LPAREN', 'RPAREN', 'LBRACE', 'RBRACE', 'QUOTED', 'COLON',
];
/** Token types whose presence right after the *next* candidate token means that candidate starts
 *  a new clause, not more of the current value — e.g. "level:error service:pay" must not swallow
 *  "service" into level's value just because it's separated only by whitespace. */
const CLAUSE_STARTERS: TokType[] = ['COLON', 'GT', 'GTE', 'LT', 'LTE'];

interface Literal {
  value: string;
  isPhrase: boolean;
  start: number;
  end: number;
}

class Parser {
  private readonly input: string;
  private readonly tokens: Token[];
  private pos = 0;

  constructor(input: string) {
    this.input = input;
    this.tokens = lex(input);
  }

  parse(): KqlNode {
    const node = this.parseOr();
    const t = this.peek();
    if (t.type !== 'EOF') {
      // No implicit AND — anything left over after a full query is a syntax error, same as
      // Kibana. (A run of space-separated words was already folded into one Literal by
      // consumeLiteral(); reaching here means an explicit `and`/`or` was missing.)
      throw this.errorAt(['end of input', '"and"', '"or"'], t);
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
      this.expect('RPAREN', '")"');
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
      const val = this.consumeLiteral();
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

    // Bare term (phrase or unquoted value — spaces do not end it)
    const val = this.consumeLiteral();
    const node: KqlIs = {
      type: 'is',
      field: null,
      value: val.value,
      isPhrase: val.isPhrase,
      isWildcard: !val.isPhrase && WILDCARD_RE.test(val.value),
      isExists: false,
    };
    return node;
  }

  private parseFieldExpr(): KqlNode {
    const fieldTok = this.consume(); // IDENT
    const field = fieldTok.value;
    this.consume(); // COLON

    // field:*  → exists (the bare * is lexed to a WILDCARD_STAR sentinel)
    if (this.peek().type === 'IDENT' && this.peek().value === WILDCARD_STAR) {
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
      this.expect('RPAREN', '")"');
      return node;
    }

    // field:value — value may itself contain further ':' runs (12:30:45, url:http://x).
    const val = this.consumeFieldValue();
    const raw = this.input.slice(fieldTok.start, val.end);
    const node: KqlIs = {
      type: 'is', field,
      value: val.value,
      isPhrase: val.isPhrase,
      isWildcard: !val.isPhrase && WILDCARD_RE.test(val.value),
      isExists: false,
      raw,
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
    const val = this.consumeLiteral();
    const is: KqlIs = {
      type: 'is', field,
      value: val.value,
      isPhrase: val.isPhrase,
      isWildcard: !val.isPhrase && WILDCARD_RE.test(val.value),
      isExists: false,
    };
    return negate ? ({ type: 'not', operand: is } as KqlNot) : is;
  }

  // ── Literal / value consumption ─────────────────────────────────────────────

  /**
   * A field:value's value, extended across any ':' runs it contains (12:30:45, url:http://x) —
   * the colon only means "start a new clause" at the top level, between two Literals it's just
   * another character.
   */
  private consumeFieldValue(): { value: string; isPhrase: boolean; end: number } {
    let lit = this.consumeLiteral();
    let value = lit.value;
    let end = lit.end;
    while (!lit.isPhrase && this.peek().type === 'COLON') {
      const colonTok = this.consume();
      value += this.gap(end, colonTok.start) + ':';
      lit = this.consumeLiteral();
      value += this.gap(colonTok.end, lit.start) + lit.value;
      end = lit.end;
    }
    return { value, isPhrase: lit.isPhrase, end };
  }

  /**
   * A single KQL Literal: a quoted phrase (one token), or a run of IDENT tokens greedily merged
   * into one value — spaces between them are ordinary characters, not a boundary. Absorption
   * stops at anything in STOPS_LITERAL, or at an IDENT that is itself the start of the *next*
   * clause (its following token is ':' or a range operator).
   */
  private consumeLiteral(): Literal {
    const t = this.peek();
    if (t.type === 'QUOTED') {
      this.consume();
      return { value: t.value, isPhrase: true, start: t.start, end: t.end };
    }
    if (t.type !== 'IDENT') {
      throw this.errorAt(['value'], t);
    }
    this.consume();
    let value = t.value;
    let end = t.end;
    while (this.canAbsorb()) {
      const next = this.consume();
      value += this.gap(end, next.start) + next.value;
      end = next.end;
    }
    return { value, isPhrase: false, start: t.start, end };
  }

  private canAbsorb(): boolean {
    const t = this.peek();
    if (STOPS_LITERAL.includes(t.type)) {
      return false;
    }
    // An IDENT immediately followed by ':' / a range operator starts a new clause, not more of
    // this value — e.g. "level:error service:pay" must NOT swallow "service" into level's value.
    return !CLAUSE_STARTERS.includes(this.peek2().type);
  }

  /** Raw source text between two token boundaries — preserves whatever whitespace was there. */
  private gap(prevEnd: number, nextStart: number): string {
    return this.input.slice(prevEnd, nextStart);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

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

  private expect(type: TokType, label: string): Token {
    const t = this.peek();
    if (t.type !== type) {
      throw this.errorAt([label], t);
    }
    return this.consume();
  }

  private errorAt(expected: string[], t: Token): KqlSyntaxError {
    const found = t.type === 'EOF' ? null : this.input.slice(t.start, t.end);
    const position = t.type === 'EOF' ? this.input.length : t.start;
    return new KqlSyntaxError(expected, found, position, this.input);
  }
}

/** Parse a KQL string into an AST. Throws KqlSyntaxError on parse errors. */
export function parseKql(input: string): KqlNode {
  return new Parser(input.trim()).parse();
}
