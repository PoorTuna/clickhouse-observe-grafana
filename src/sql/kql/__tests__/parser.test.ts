import { parseKql } from '../_parser';
import { KqlSyntaxError } from '../_error';
import { KqlAnd, KqlIs, KqlNot, KqlOr, KqlRange } from '../ast';

describe('KQL parser', () => {
  // ── Simple field:value ───────────────────────────────────────────────────
  it('parses a simple field:value', () => {
    const node = parseKql('level:error') as KqlIs;
    expect(node.type).toBe('is');
    expect(node.field).toBe('level');
    expect(node.value).toBe('error');
    expect(node.isPhrase).toBe(false);
    expect(node.isWildcard).toBe(false);
    expect(node.isExists).toBe(false);
  });

  it('parses a quoted phrase', () => {
    const node = parseKql('message:"hello world"') as KqlIs;
    expect(node.type).toBe('is');
    expect(node.field).toBe('message');
    expect(node.value).toBe('hello world');
    expect(node.isPhrase).toBe(true);
    expect(node.isWildcard).toBe(false);
  });

  it('parses a bare term (no field)', () => {
    const node = parseKql('foobar') as KqlIs;
    expect(node.type).toBe('is');
    expect(node.field).toBeNull();
    expect(node.value).toBe('foobar');
    expect(node.isWildcard).toBe(false);
  });

  it('parses a bare quoted term', () => {
    const node = parseKql('"my phrase"') as KqlIs;
    expect(node.type).toBe('is');
    expect(node.field).toBeNull();
    expect(node.value).toBe('my phrase');
    expect(node.isPhrase).toBe(true);
    expect(node.isWildcard).toBe(false);
  });

  // ── Wildcard ──────────────────────────────────────────────────────────────
  it('parses a wildcard value', () => {
    const node = parseKql('service:payment*') as KqlIs;
    expect(node.field).toBe('service');
    expect(node.isWildcard).toBe(true);
    expect(node.isExists).toBe(false);
  });

  it('leading wildcard *foo → isWildcard true', () => {
    const node = parseKql('*foo') as KqlIs;
    expect(node.field).toBeNull();
    expect(node.isWildcard).toBe(true);
  });

  it('infix wildcard f*o → isWildcard true', () => {
    const node = parseKql('service:f*o') as KqlIs;
    expect(node.isWildcard).toBe(true);
  });

  it('? is a literal character, not a wildcard — real KQL supports only *', () => {
    const node = parseKql('host:web?') as KqlIs;
    expect(node.isWildcard).toBe(false);
    expect(node.value).toBe('web?');
  });

  it('escaped \\* is NOT a wildcard', () => {
    const node = parseKql('service:pay\\*') as KqlIs;
    expect(node.field).toBe('service');
    expect(node.value).toBe('pay*'); // literal asterisk
    expect(node.isWildcard).toBe(false);
  });

  it('escaped \\? is NOT a wildcard', () => {
    const node = parseKql('service:web\\?') as KqlIs;
    expect(node.isWildcard).toBe(false);
    expect(node.value).toBe('web?');
  });

  it('mix: literal \\* followed by wildcard * → isWildcard true', () => {
    // pay\*ment* → value is "pay*ment<STAR_SENTINEL>"
    const node = parseKql('service:pay\\*ment*') as KqlIs;
    expect(node.isWildcard).toBe(true);
  });

  // ── Exists ────────────────────────────────────────────────────────────────
  it('parses field:* as exists', () => {
    const node = parseKql('user.id:*') as KqlIs;
    expect(node.type).toBe('is');
    expect(node.field).toBe('user.id');
    expect(node.isExists).toBe(true);
    expect(node.isWildcard).toBe(false);
  });

  it('traceId:* → isExists true', () => {
    const node = parseKql('traceId:*') as KqlIs;
    expect(node.isExists).toBe(true);
  });

  // ── Range ─────────────────────────────────────────────────────────────────
  it('parses a >= range', () => {
    const node = parseKql('responseTime >= 500') as KqlRange;
    expect(node.type).toBe('range');
    expect(node.field).toBe('responseTime');
    expect(node.op).toBe('gte');
    expect(node.value).toBe('500');
  });

  it('parses a < range', () => {
    const node = parseKql('latency < 100') as KqlRange;
    expect(node.op).toBe('lt');
    expect(node.value).toBe('100');
  });

  it('parses a > range', () => {
    const node = parseKql('count > 0') as KqlRange;
    expect(node.op).toBe('gt');
  });

  it('parses a <= range', () => {
    const node = parseKql('status <= 399') as KqlRange;
    expect(node.op).toBe('lte');
  });

  // ── NOT ───────────────────────────────────────────────────────────────────
  it('parses not', () => {
    const node = parseKql('not level:debug') as KqlNot;
    expect(node.type).toBe('not');
    const inner = node.operand as KqlIs;
    expect(inner.field).toBe('level');
    expect(inner.value).toBe('debug');
  });

  it('double not: not not level:debug', () => {
    const node = parseKql('not not level:debug') as KqlNot;
    expect(node.type).toBe('not');
    expect(node.operand.type).toBe('not');
  });

  // ── AND ───────────────────────────────────────────────────────────────────
  it('parses explicit and', () => {
    const node = parseKql('level:error and service:payment') as KqlAnd;
    expect(node.type).toBe('and');
    expect((node.left as KqlIs).field).toBe('level');
    expect((node.right as KqlIs).field).toBe('service');
  });

  // ── OR ────────────────────────────────────────────────────────────────────
  it('parses explicit or', () => {
    const node = parseKql('level:error or level:warn') as KqlOr;
    expect(node.type).toBe('or');
  });

  // ── Precedence: NOT > AND > OR ────────────────────────────────────────────
  it('respects NOT > AND precedence', () => {
    const node = parseKql('level:error and not level:debug') as KqlAnd;
    expect(node.type).toBe('and');
    expect(node.right.type).toBe('not');
  });

  it('respects AND > OR precedence', () => {
    const node = parseKql('a:1 or b:2 and c:3') as KqlOr;
    expect(node.type).toBe('or');
    expect(node.right.type).toBe('and');
  });

  it('long precedence chain: a or b and not c or d', () => {
    // Parses as: (a) OR ((b) AND (NOT c)) OR (d)
    // left-associative OR: OR(OR(a, AND(b, NOT c)), d)
    const node = parseKql('a:1 or b:2 and not c:3 or d:4') as KqlOr;
    expect(node.type).toBe('or');
    expect(node.right.type).toBe('is');
  });

  // ── Parentheses grouping ──────────────────────────────────────────────────
  it('handles parentheses grouping', () => {
    const node = parseKql('(level:error or level:warn) and service:api') as KqlAnd;
    expect(node.type).toBe('and');
    expect(node.left.type).toBe('or');
    expect((node.right as KqlIs).field).toBe('service');
  });

  it('double-nested parentheses: ((level:error))', () => {
    const node = parseKql('((level:error))') as KqlIs;
    expect(node.type).toBe('is');
    expect(node.field).toBe('level');
  });

  // ── No implicit AND — space is an ordinary character inside a value ───────
  // Matches Elastic's kuery grammar: UnquotedLiteral absorbs whitespace, so space-separated
  // words with no explicit and/or/not are ONE value, not multiple AND-ed clauses. This is the
  // fix for the reported bug: ".*xd something something with spaces.*" used to fan out into
  // five required clauses instead of being searched as one string.
  it('two space-separated bare words with no "and" → one merged value, not an AND', () => {
    const node = parseKql('foo bar') as KqlIs;
    expect(node.type).toBe('is');
    expect(node.value).toBe('foo bar');
  });

  it('three space-separated words → one merged value', () => {
    const node = parseKql('a b c') as KqlIs;
    expect(node.type).toBe('is');
    expect(node.value).toBe('a b c');
  });

  it('mixed implicit/explicit: foo AND bar baz → AND(foo, "bar baz")', () => {
    // "AND" still splits clauses; the words after it with no further "and" merge into one value.
    const node = parseKql('foo AND bar baz') as KqlAnd;
    expect(node.type).toBe('and');
    expect((node.left as KqlIs).value).toBe('foo');
    expect((node.right as KqlIs).value).toBe('bar baz');
  });

  it('two field:value clauses with no "and" between them throws (Kibana requires it explicit)', () => {
    expect(() => parseKql('level:error service:pay')).toThrow(KqlSyntaxError);
  });

  it('a field value absorbs trailing bare words: level:error timeout → one value "error timeout"', () => {
    const node = parseKql('level:error timeout') as KqlIs;
    expect(node.type).toBe('is');
    expect(node.field).toBe('level');
    expect(node.value).toBe('error timeout');
  });

  it('field value absorbs a colon run: startedAt:12:30:45 → value "12:30:45"', () => {
    const node = parseKql('startedAt:12:30:45') as KqlIs;
    expect(node.field).toBe('startedAt');
    expect(node.value).toBe('12:30:45');
  });

  it('url:http://x → value is the whole "http://x", raw carries the full field:value text', () => {
    const node = parseKql('url:http://x') as KqlIs;
    expect(node.field).toBe('url');
    expect(node.value).toBe('http://x');
    expect(node.raw).toBe('url:http://x');
  });

  it('a bare quoted phrase does not absorb a following word without and/or (syntax error)', () => {
    expect(() => parseKql('"foo" bar')).toThrow(KqlSyntaxError);
  });

  // ── Value list ────────────────────────────────────────────────────────────
  it('parses field:(a or b)', () => {
    const node = parseKql('level:(error or warn)') as KqlOr;
    expect(node.type).toBe('or');
    const left = node.left as KqlIs;
    const right = node.right as KqlIs;
    expect(left.field).toBe('level');
    expect(left.value).toBe('error');
    expect(right.field).toBe('level');
    expect(right.value).toBe('warn');
  });

  it('parses field:(a and b)', () => {
    const node = parseKql('tag:(foo and bar)') as KqlAnd;
    expect(node.type).toBe('and');
    expect((node.left as KqlIs).field).toBe('tag');
  });

  it('parses field:(a or not b)', () => {
    const node = parseKql('level:(info or not debug)') as KqlOr;
    expect(node.type).toBe('or');
    expect(node.right.type).toBe('not');
    const inner = (node.right as KqlNot).operand as KqlIs;
    expect(inner.field).toBe('level');
    expect(inner.value).toBe('debug');
  });

  it('parses field:(not a)', () => {
    const node = parseKql('level:(not error)') as KqlNot;
    expect(node.type).toBe('not');
    expect((node.operand as KqlIs).field).toBe('level');
    expect((node.operand as KqlIs).value).toBe('error');
  });

  // ── Case-insensitive keywords ─────────────────────────────────────────────
  it('handles AND/OR/NOT case-insensitively', () => {
    const node = parseKql('level:error AND service:api') as KqlAnd;
    expect(node.type).toBe('and');
    const node2 = parseKql('level:error OR level:warn') as KqlOr;
    expect(node2.type).toBe('or');
    const node3 = parseKql('NOT level:debug') as KqlNot;
    expect(node3.type).toBe('not');
  });

  // ── Dotted field names ────────────────────────────────────────────────────
  it('parses dotted field names', () => {
    const node = parseKql('http.method:GET') as KqlIs;
    expect(node.field).toBe('http.method');
    expect(node.value).toBe('GET');
    expect(node.isWildcard).toBe(false);
  });

  it('dotted field with wildcard: http.path:api*', () => {
    const node = parseKql('http.path:api*') as KqlIs;
    expect(node.field).toBe('http.path');
    expect(node.isWildcard).toBe(true);
  });

  // ── Escaped keyword as field name ─────────────────────────────────────────
  it('escaped \\and stays as IDENT field name', () => {
    // \and:value → field="and", not an AND operator followed by :value
    const node = parseKql('\\and:value') as KqlIs;
    expect(node.type).toBe('is');
    expect(node.field).toBe('and');
    expect(node.value).toBe('value');
  });

  // ── Error cases ───────────────────────────────────────────────────────────
  it('empty string throws KqlSyntaxError', () => {
    expect(() => parseKql('')).toThrow(KqlSyntaxError);
  });

  it('unclosed parenthesis throws KqlSyntaxError, expecting ")"', () => {
    expect(() => parseKql('(level:error')).toThrow(KqlSyntaxError);
  });

  it('KqlSyntaxError message is Kibana-shaped: "Expected X but Y found." + input + caret', () => {
    try {
      parseKql('level:error service:pay');
      throw new Error('expected parseKql to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(KqlSyntaxError);
      const err = e as KqlSyntaxError;
      expect(err.message).toMatch(/^Expected .+ but "service" found\./);
      expect(err.message.split('\n')).toEqual([
        expect.stringMatching(/^Expected/),
        'level:error service:pay',
        '------------^',
      ]);
    }
  });
});
