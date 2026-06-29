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
  });

  it('parses a bare term (no field)', () => {
    const node = parseKql('foobar') as KqlIs;
    expect(node.type).toBe('is');
    expect(node.field).toBeNull();
    expect(node.value).toBe('foobar');
  });

  it('parses a bare quoted term', () => {
    const node = parseKql('"my phrase"') as KqlIs;
    expect(node.type).toBe('is');
    expect(node.field).toBeNull();
    expect(node.value).toBe('my phrase');
    expect(node.isPhrase).toBe(true);
  });

  // ── Wildcard ──────────────────────────────────────────────────────────────
  it('parses a wildcard value', () => {
    const node = parseKql('service:payment*') as KqlIs;
    expect(node.field).toBe('service');
    expect(node.value).toBe('payment*');
    expect(node.isWildcard).toBe(true);
    expect(node.isExists).toBe(false);
  });

  // ── Exists ────────────────────────────────────────────────────────────────
  it('parses field:* as exists', () => {
    const node = parseKql('user.id:*') as KqlIs;
    expect(node.type).toBe('is');
    expect(node.field).toBe('user.id');
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

  // ── Parentheses grouping ──────────────────────────────────────────────────
  it('handles parentheses grouping', () => {
    const node = parseKql('(level:error or level:warn) and service:api') as KqlAnd;
    expect(node.type).toBe('and');
    expect(node.left.type).toBe('or');
    expect((node.right as KqlIs).field).toBe('service');
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
  });
});
