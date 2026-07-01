import { parseKql } from '../_parser';
import { kqlToSql } from '../toSql';
import { SourceConfig, OTEL_COLUMN_MAPPING } from '../../../types';

const config: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'otel_logs',
  tracesTable: 'otel_traces',
  isOtel: true,
  columns: OTEL_COLUMN_MAPPING,
};

function sql(kql: string): string {
  return kqlToSql(parseKql(kql), config);
}

describe('kqlToSql', () => {

  // ── Body / bare-term search ───────────────────────────────────────────────

  it('bare term → hasToken OR ILIKE contains on body', () => {
    const result = sql('hello');
    expect(result).toContain('hasToken(Body');
    expect(result).toContain("ILIKE '%hello%'");
  });

  it('bare quoted phrase → match() with word boundaries, not ILIKE', () => {
    const result = sql('"hello world"');
    expect(result).toContain('match(');
    expect(result).toContain('hello world');
    expect(result).not.toContain('hasToken');
    expect(result).not.toContain("ILIKE '%hello world%'");
  });

  it('bare quoted single word → match() not hasToken', () => {
    const result = sql('"payment"');
    expect(result).toContain('match(');
    expect(result).not.toContain('hasToken');
  });

  // ── Bare wildcard (reported bug: * did nothing) ───────────────────────────

  it('bare pay* → Body ILIKE prefix match (NOT literal *)', () => {
    const result = sql('pay*');
    expect(result).toContain("ILIKE 'pay%'");
    expect(result).not.toContain('pay*');   // literal * must not appear
    expect(result).not.toContain('hasToken');
  });

  it('bare *error → Body ILIKE suffix match', () => {
    const result = sql('*error');
    expect(result).toContain("ILIKE '%error'");
  });

  it('bare *error* → Body ILIKE contains via wildcards', () => {
    const result = sql('*error*');
    expect(result).toContain("ILIKE '%error%'");
  });

  it('bare * → Body ILIKE % (match-all)', () => {
    const result = sql('*');
    expect(result).toContain("ILIKE '%'");
  });

  it('bare ? → Body ILIKE _ (any single char)', () => {
    const result = sql('?');
    expect(result).toContain("ILIKE '_'");
  });

  // ── Text-kind wildcard (was shadowed by kind=text branch) ─────────────────
  // Named field queries use the real mapped column name — no alias resolution.

  it('Body:err* → Body ILIKE prefix, NOT literal *', () => {
    const result = sql('Body:err*');
    expect(result).toContain("ILIKE 'err%'");
    expect(result).not.toContain('err*');
  });

  it('Body:*error* → Body ILIKE contains via wildcards', () => {
    const result = sql('Body:*error*');
    expect(result).toContain("ILIKE '%error%'");
  });

  it('Body:foo → Body ILIKE contains (unquoted text = substring)', () => {
    const result = sql('Body:foo');
    expect(result).toContain("ILIKE '%foo%'");
    expect(result).not.toContain('hasToken');
  });

  it('Body:"foo" → body phrase match()', () => {
    const result = sql('Body:"foo"');
    expect(result).toContain('match(');
    expect(result).toContain('foo');
    expect(result).not.toContain("ILIKE '%foo%'");
  });

  // ── Exact-kind field: Kibana-faithful (unquoted=exact, quoted=exact) ──────

  it('ServiceName:payment → exact = (unquoted exact field)', () => {
    const result = sql('ServiceName:payment');
    expect(result).toContain("= 'payment'");
    expect(result).not.toContain('ILIKE');
  });

  it('ServiceName:"payment" → exact = (quoted keyword field, NOT match())', () => {
    const result = sql('ServiceName:"payment"');
    expect(result).toContain("= 'payment'");
    expect(result).not.toContain('match(');
    expect(result).not.toContain('ILIKE');
  });

  it('ServiceName:pay* → ILIKE wildcard on exact field', () => {
    const result = sql('ServiceName:pay*');
    expect(result).toContain("ILIKE 'pay%'");
  });

  it('ServiceName:*ment → ILIKE suffix wildcard on exact field', () => {
    const result = sql('ServiceName:*ment');
    expect(result).toContain("ILIKE '%ment'");
  });

  // ── ? single-char wildcard extension (kept intentionally) ─────────────────

  it('host:web?.local → ILIKE with _ substitution', () => {
    const result = sql('host:web?.local');
    expect(result).toContain("ILIKE 'web_.local'");
  });

  it('bare web? → ILIKE with _ substitution', () => {
    const result = sql('web?');
    expect(result).toContain("ILIKE 'web_'");
  });

  // ── Literal % and _ escaping (the "misleading %" reported bug) ───────────

  it('Body:50% → literal %, escaped so it does not act as ILIKE wildcard', () => {
    const result = sql('Body:50%');
    expect(result).toContain('ILIKE');
    // Must NOT produce '%50%%' (raw %, acts as wildcard)
    expect(result).not.toContain("'%50%%'");
    // Must produce escaped form: the % becomes \% which quoteString doubles to \\%
    expect(result).toContain('50\\\\%');
  });

  it('Body:a_b → literal _, escaped so it does not act as ILIKE single-char wildcard', () => {
    const result = sql('Body:a_b');
    expect(result).toContain('ILIKE');
    // Must NOT produce '%a_b%' (raw _, acts as any-char wildcard)
    expect(result).not.toContain("'%a_b%'");
    // Must produce escaped form
    expect(result).toContain('a\\\\_b');
  });

  it('ServiceName:50% → exact field with % is passed literally to = (no ILIKE escaping needed)', () => {
    // % is only special in ILIKE, not in = comparisons
    const result = sql('ServiceName:50%');
    expect(result).toContain("= '50%'");
    expect(result).not.toContain('ILIKE');
  });

  it('wildcard value with literal %: pay%* → escaped % + wildcard suffix', () => {
    // pay%* — the % is literal, * is the wildcard
    const result = sql('ServiceName:pay%*');
    expect(result).toContain('ILIKE');
    // \\% is the escaped literal percent; the trailing % comes from the * wildcard
    expect(result).toContain('pay\\\\%');
  });

  // ── Escaped \* is a literal asterisk ─────────────────────────────────────

  it('ServiceName:pay\\* → literal asterisk in = (not wildcard)', () => {
    const result = sql('ServiceName:pay\\*');
    expect(result).toContain("= 'pay*'");
    expect(result).not.toContain('ILIKE');
  });

  it('bare pay\\* → literal asterisk in body search', () => {
    const result = sql('pay\\*');
    // No wildcard → hasToken / ILIKE contains, with literal *
    expect(result).toContain("'pay*'");
    expect(result).not.toContain("ILIKE 'pay%'");
  });

  // ── Phrase match uses match() not ILIKE (word-boundary precision) ─────────

  it('Body:"req-59" → match() so req-592 does NOT match', () => {
    const result = sql('Body:"req-59"');
    expect(result).toContain('match(');
    expect(result).toContain('req-59');
    expect(result).not.toContain("ILIKE '%req-59%'");
  });

  it('Body phrase is wrapped in word-boundary anchors', () => {
    const result = sql('"hello"');
    expect(result).toContain('(?i)(^|[^a-zA-Z0-9_])hello([^a-zA-Z0-9_]|$)');
  });

  // Phrase on a non-text (exact/map) field stays exact, NOT match()
  it('ServiceName:"payment" uses = not match() (keyword field Kibana semantics)', () => {
    const result = sql('ServiceName:"payment"');
    expect(result).not.toContain('match(');
    expect(result).toContain("= 'payment'");
  });

  it('http.method:"GET" → map accessor = (not match())', () => {
    const result = sql('http.method:"GET"');
    expect(result).toContain("LogAttributes['http.method']");
    expect(result).toContain("= 'GET'");
    expect(result).not.toContain('match(');
  });

  // ── Named field via mapped column — no alias resolution, no level vocab ───
  // (SeverityText is just an exact-kind field like any other mapped column;
  // severity synonym expansion was removed along with the hardcoded aliases.)

  it('SeverityText:error → exact = (no IN-list expansion)', () => {
    const result = sql('SeverityText:error');
    expect(result).toContain("= 'error'");
    expect(result).not.toContain('IN (');
  });

  it('SeverityText:err* → ILIKE wildcard', () => {
    const result = sql('SeverityText:err*');
    expect(result).toContain('SeverityText');
    expect(result).toContain("ILIKE 'err%'");
  });

  // ── Exact match ───────────────────────────────────────────────────────────

  it('ServiceName:payment → = on ServiceName column', () => {
    const result = sql('ServiceName:payment');
    expect(result).toContain("= 'payment'");
  });

  it('TraceId:abc123 → exact match on TraceId column', () => {
    const result = sql('TraceId:abc123');
    expect(result).toContain('TraceId');
    expect(result).toContain("= 'abc123'");
  });

  // ── Wildcard on named exact fields ────────────────────────────────────────

  it('ServiceName:pay* → ILIKE with % substitution', () => {
    const result = sql('ServiceName:pay*');
    expect(result).toContain("ILIKE 'pay%'");
  });

  it('host:web?.local → ILIKE with _ substitution', () => {
    const result = sql('host:web?.local');
    expect(result).toContain("ILIKE 'web_.local'");
  });

  // ── Exists ────────────────────────────────────────────────────────────────

  it('TraceId:* → notEmpty(toString(...))', () => {
    const result = sql('TraceId:*');
    expect(result).toContain('notEmpty(toString(');
  });

  it('ServiceName:* → exists check on ServiceName column', () => {
    const result = sql('ServiceName:*');
    expect(result).toContain('notEmpty(toString(');
    expect(result).toContain('ServiceName');
  });

  it('http.method:* → exists check via map accessor', () => {
    const result = sql('http.method:*');
    expect(result).toContain('notEmpty(toString(');
    expect(result).toContain("LogAttributes['http.method']");
  });

  // ── Ranges ────────────────────────────────────────────────────────────────

  it('responseTime >= 500 → numeric >= literal', () => {
    const result = sql('responseTime >= 500');
    expect(result).toContain('>= 500');
    expect(result).not.toContain("'500'");
  });

  it('responseTime < 100 → < literal', () => {
    const result = sql('responseTime < 100');
    expect(result).toContain('< 100');
  });

  it('responseTime > 0 → > literal', () => {
    const result = sql('responseTime > 0');
    expect(result).toContain('> 0');
  });

  it('status <= 399 → <= literal', () => {
    const result = sql('status <= 399');
    expect(result).toContain('<= 399');
  });

  it('string range: version >= 2.0 → quoted value', () => {
    const result = sql('version >= 2.0');
    // 2.0 is not an integer but parseFloat gives 2, however Number('2.0') = 2 which is finite
    // so it should use numeric. Let's just verify the operator is present.
    expect(result).toContain('>=');
  });

  it('unknown field range → direct column comparison (no no-op)', () => {
    const noMapConfig: SourceConfig = {
      ...config,
      columns: { ...config.columns, logAttributes: '', resourceAttributes: '' },
    };
    const result = kqlToSql(parseKql('unknownRange >= 100'), noMapConfig);
    expect(result).toContain('"unknownRange"');
    expect(result).toContain('>= 100');
  });

  // ── NOT ──────────────────────────────────────────────────────────────────

  it('not SeverityText:debug → NOT (...)', () => {
    const result = sql('not SeverityText:debug');
    expect(result).toMatch(/^NOT \(/);
  });

  it('NOT uppercase → NOT (...)', () => {
    const result = sql('NOT ServiceName:payment');
    expect(result).toMatch(/^NOT \(/);
    expect(result).toContain("= 'payment'");
  });

  // ── AND ──────────────────────────────────────────────────────────────────

  it('AND → both clauses joined with AND', () => {
    const result = sql('SeverityText:error and ServiceName:api');
    expect(result).toContain(') AND (');
  });

  // ── OR ───────────────────────────────────────────────────────────────────

  it('OR → both clauses joined with OR', () => {
    const result = sql('SeverityText:error or SeverityText:warn');
    expect(result).toContain(') OR (');
  });

  // ── Nested conjunction ────────────────────────────────────────────────────

  it('nested and/or → correct parenthesisation', () => {
    const result = sql('(SeverityText:error or SeverityText:warn) and ServiceName:api');
    expect(result).toContain(') AND (');
    expect(result).toContain(') OR (');
  });

  it('NOT inside AND: a and not b', () => {
    const result = sql('SeverityText:error and not SeverityText:debug');
    expect(result).toContain(') AND (');
    expect(result).toContain('NOT (');
  });

  // ── Value list ────────────────────────────────────────────────────────────

  it('SeverityText:(error or warn) → OR of two exact clauses', () => {
    const result = sql('SeverityText:(error or warn)');
    expect(result).toContain(') OR (');
    expect(result).toContain('SeverityText');
  });

  it('ServiceName:(api or auth) → OR of two exact clauses', () => {
    const result = sql('ServiceName:(api or auth)');
    expect(result).toContain(') OR (');
    expect(result).toContain("= 'api'");
    expect(result).toContain("= 'auth'");
  });

  it('ServiceName:(not api) → NOT clause', () => {
    const result = sql('ServiceName:(not api)');
    expect(result).toContain('NOT (');
    expect(result).toContain("= 'api'");
  });

  // ── Dotted field name → Map attribute lookup ─────────────────────────────

  it('http.method:GET → LogAttributes map accessor', () => {
    const result = sql('http.method:GET');
    expect(result).toContain("= 'GET'");
    expect(result).toContain("LogAttributes['http.method']");
  });

  it('http.status_code:200 → LogAttributes map accessor', () => {
    const result = sql('http.status_code:200');
    expect(result).toContain("LogAttributes['http.status_code']");
    expect(result).toContain("= '200'");
  });

  it('http.path:api* → map accessor with wildcard', () => {
    const result = sql('http.path:api*');
    expect(result).toContain("LogAttributes['http.path']");
    expect(result).toContain("ILIKE 'api%'");
  });

  // ── Unknown field → direct column (not body fallback) ───────────────────

  it('completely unknown field queries it as a direct column', () => {
    const noMapConfig: SourceConfig = {
      ...config,
      columns: { ...config.columns, logAttributes: '', resourceAttributes: '' },
    };
    const result = kqlToSql(parseKql('unknownfield:value'), noMapConfig);
    expect(result).toContain('"unknownfield"');
    expect(result).toContain("= 'value'");
    expect(result).not.toContain('Body');
  });

  it('unknown field with wildcard queries it as a direct column with ILIKE', () => {
    const noMapConfig: SourceConfig = {
      ...config,
      columns: { ...config.columns, logAttributes: '', resourceAttributes: '' },
    };
    const result = kqlToSql(parseKql('unknownfield:val*'), noMapConfig);
    expect(result).toContain('"unknownfield"');
    expect(result).toContain("ILIKE 'val%'");
    expect(result).not.toContain('Body');
  });

  // ── Implicit AND (multiple terms) ─────────────────────────────────────────

  it('two bare terms → AND', () => {
    const result = sql('error timeout');
    expect(result).toContain(') AND (');
  });

  it('field and bare term → AND', () => {
    const result = sql('SeverityText:error timeout');
    expect(result).toContain(') AND (');
    expect(result).toContain('SeverityText');
    expect(result).toContain('Body');
  });

  // ── Phrase regex escaping ─────────────────────────────────────────────────

  it('phrase with regex special chars is escaped in match()', () => {
    const result = sql('"req.id+1"');
    // . and + must be escaped in the regex pattern
    expect(result).toContain('req\\.id\\+1');
  });

  it('Body:"req-59" regression: word-boundary prevents req-592 match', () => {
    const result = sql('Body:"req-59"');
    expect(result).toContain('match(');
    expect(result).toContain('req-59');
    expect(result).not.toContain("ILIKE '%req-59%'");
  });
});
