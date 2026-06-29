import { parseKql } from '../_parser';
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

  it('? wildcard → isWildcard true', () => {
    const node = parseKql('host:web?') as KqlIs;
    expect(node.isWildcard).toBe(true);
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

  // ── Implicit AND (space-separated terms) ─────────────────────────────────
  it('two space-separated bare terms → implicit AND', () => {
    const node = parseKql('foo bar') as KqlAnd;
    expect(node.type).toBe('and');
    expect((node.left as KqlIs).value).toBe('foo');
    expect((node.right as KqlIs).value).toBe('bar');
  });

  it('three space-separated terms → nested implicit AND', () => {
    const node = parseKql('a b c') as KqlAnd;
    expect(node.type).toBe('and');
    // Should be AND(AND(a,b),c) or AND(a,AND(b,c)); either is acceptable.
    // Just verify all three leaf nodes exist somewhere
    const flatten = (n: unknown): string[] => {
      const kn = n as { type: string; left?: unknown; right?: unknown; operand?: unknown; value?: string };
      if (kn.type === 'is') { return [kn.value!]; }
      if (kn.type === 'and' || kn.type === 'or') { return [...flatten(kn.left), ...flatten(kn.right)]; }
      return [];
    };
    expect(flatten(node).sort()).toEqual(['a', 'b', 'c']);
  });

  it('mixed implicit/explicit: foo AND bar baz', () => {
    // "foo AND bar baz" → AND(AND(foo,bar),baz)
    const node = parseKql('foo AND bar baz');
    expect(node.type).toBe('and');
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
  it('empty string throws', () => {
    expect(() => parseKql('')).toThrow();
  });

  it('unclosed parenthesis throws', () => {
    expect(() => parseKql('(level:error')).toThrow();
  });
});
