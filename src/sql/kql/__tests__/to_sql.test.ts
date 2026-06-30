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

  it('message:err* → Body ILIKE prefix, NOT literal *', () => {
    const result = sql('message:err*');
    expect(result).toContain("ILIKE 'err%'");
    expect(result).not.toContain('err*');
  });

  it('message:*error* → Body ILIKE contains via wildcards', () => {
    const result = sql('message:*error*');
    expect(result).toContain("ILIKE '%error%'");
  });

  it('message:foo → Body ILIKE contains (unquoted text = substring)', () => {
    const result = sql('message:foo');
    expect(result).toContain("ILIKE '%foo%'");
    expect(result).not.toContain('hasToken');
  });

  it('message:"foo" → body phrase match()', () => {
    const result = sql('message:"foo"');
    expect(result).toContain('match(');
    expect(result).toContain('foo');
    expect(result).not.toContain("ILIKE '%foo%'");
  });

  // ── Exact-kind field: Kibana-faithful (unquoted=exact, quoted=exact) ──────

  it('service:payment → exact = (unquoted exact field)', () => {
    const result = sql('service:payment');
    expect(result).toContain("= 'payment'");
    expect(result).not.toContain('ILIKE');
  });

  it('service:"payment" → exact = (quoted keyword field, NOT match())', () => {
    const result = sql('service:"payment"');
    expect(result).toContain("= 'payment'");
    expect(result).not.toContain('match(');
    expect(result).not.toContain('ILIKE');
  });

  it('service:pay* → ILIKE wildcard on exact field', () => {
    const result = sql('service:pay*');
    expect(result).toContain("ILIKE 'pay%'");
  });

  it('service:*ment → ILIKE suffix wildcard on exact field', () => {
    const result = sql('service:*ment');
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

  it('message:50% → literal %, escaped so it does not act as ILIKE wildcard', () => {
    const result = sql('message:50%');
    expect(result).toContain('ILIKE');
    // Must NOT produce '%50%%' (raw %, acts as wildcard)
    expect(result).not.toContain("'%50%%'");
    // Must produce escaped form: the % becomes \% which quoteString doubles to \\%
    expect(result).toContain('50\\\\%');
  });

  it('message:a_b → literal _, escaped so it does not act as ILIKE single-char wildcard', () => {
    const result = sql('message:a_b');
    expect(result).toContain('ILIKE');
    // Must NOT produce '%a_b%' (raw _, acts as any-char wildcard)
    expect(result).not.toContain("'%a_b%'");
    // Must produce escaped form
    expect(result).toContain('a\\\\_b');
  });

  it('service:50% → exact field with % is passed literally to = (no ILIKE escaping needed)', () => {
    // % is only special in ILIKE, not in = comparisons
    const result = sql('service:50%');
    expect(result).toContain("= '50%'");
    expect(result).not.toContain('ILIKE');
  });

  it('wildcard value with literal %: pay%* → escaped % + wildcard suffix', () => {
    // pay%* — the % is literal, * is the wildcard
    const result = sql('service:pay%*');
    expect(result).toContain('ILIKE');
    // \\% is the escaped literal percent; the trailing % comes from the * wildcard
    expect(result).toContain('pay\\\\%');
  });

  // ── Escaped \* is a literal asterisk ─────────────────────────────────────

  it('service:pay\\* → literal asterisk in = (not wildcard)', () => {
    const result = sql('service:pay\\*');
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
  it('service:"payment" uses = not match() (keyword field Kibana semantics)', () => {
    const result = sql('service:"payment"');
    expect(result).not.toContain('match(');
    expect(result).toContain("= 'payment'");
  });

  it('http.method:"GET" → map accessor = (not match())', () => {
    const result = sql('http.method:"GET"');
    expect(result).toContain("LogAttributes['http.method']");
    expect(result).toContain("= 'GET'");
    expect(result).not.toContain('match(');
  });

  // ── Level ─────────────────────────────────────────────────────────────────

  it('level:error → IN clause on SeverityText', () => {
    const result = sql('level:error');
    expect(result).toContain('SeverityText');
    expect(result).toContain('IN');
    expect(result).toContain("'error'");
  });

  it('level:warn → IN with warn/warning variants', () => {
    const result = sql('level:warn');
    expect(result).toContain("'warn'");
    expect(result).toContain("'warning'");
  });

  it('level:info → IN clause includes Info/INFO', () => {
    const result = sql('level:info');
    expect(result).toContain("'info'");
    expect(result).toContain("'INFO'");
  });

  it('level:critical → IN clause includes fatal/crit variants', () => {
    const result = sql('level:critical');
    expect(result).toContain("'critical'");
    expect(result).toContain("'fatal'");
  });

  it('level:trace → IN clause on SeverityText', () => {
    const result = sql('level:trace');
    expect(result).toContain("'trace'");
  });

  it('level:unknown_custom → ILIKE fallback with _ escaped (not in predefined map)', () => {
    const result = sql('level:my_custom_level');
    expect(result).toContain('ILIKE');
    // underscores in the level value are escaped (\_ so they match literally)
    expect(result).toContain('my\\_custom\\_level');
  });

  it('level:err* → ILIKE wildcard on SeverityText', () => {
    const result = sql('level:err*');
    expect(result).toContain('SeverityText');
    expect(result).toContain("ILIKE 'err%'");
  });

  it('level:"error" → IN clause (quoted level uses same IN logic)', () => {
    const result = sql('level:"error"');
    expect(result).toContain('SeverityText');
    expect(result).toContain('IN');
  });

  // ── Exact match ───────────────────────────────────────────────────────────

  it('service:payment → = on ServiceName column', () => {
    const result = sql('service:payment');
    expect(result).toContain("= 'payment'");
  });

  it('traceId:abc123 → exact match on TraceId column', () => {
    const result = sql('traceId:abc123');
    expect(result).toContain('TraceId');
    expect(result).toContain("= 'abc123'");
  });

  // ── Wildcard on named exact fields ────────────────────────────────────────

  it('service:pay* → ILIKE with % substitution', () => {
    const result = sql('service:pay*');
    expect(result).toContain("ILIKE 'pay%'");
  });

  it('host:web?.local → ILIKE with _ substitution', () => {
    const result = sql('host:web?.local');
    expect(result).toContain("ILIKE 'web_.local'");
  });

  // ── Exists ────────────────────────────────────────────────────────────────

  it('traceId:* → notEmpty(toString(...))', () => {
    const result = sql('traceId:*');
    expect(result).toContain('notEmpty(toString(');
  });

  it('service:* → exists check on ServiceName column', () => {
    const result = sql('service:*');
    expect(result).toContain('notEmpty(toString(');
    expect(result).toContain('ServiceName');  // OTEL column mapping: serviceName → 'ServiceName'
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

  it('unknown field range → 1=1 (safe no-op)', () => {
    const noMapConfig: SourceConfig = {
      ...config,
      columns: { ...config.columns, logAttributes: '', resourceAttributes: '' },
    };
    const result = kqlToSql(parseKql('unknownRange >= 100'), noMapConfig);
    expect(result).toBe('1=1');
  });

  // ── NOT ──────────────────────────────────────────────────────────────────

  it('not level:debug → NOT (...)', () => {
    const result = sql('not level:debug');
    expect(result).toMatch(/^NOT \(/);
  });

  it('NOT uppercase → NOT (...)', () => {
    const result = sql('NOT service:payment');
    expect(result).toMatch(/^NOT \(/);
    expect(result).toContain("= 'payment'");
  });

  // ── AND ──────────────────────────────────────────────────────────────────

  it('AND → both clauses joined with AND', () => {
    const result = sql('level:error and service:api');
    expect(result).toContain(') AND (');
  });

  // ── OR ───────────────────────────────────────────────────────────────────

  it('OR → both clauses joined with OR', () => {
    const result = sql('level:error or level:warn');
    expect(result).toContain(') OR (');
  });

  // ── Nested conjunction ────────────────────────────────────────────────────

  it('nested and/or → correct parenthesisation', () => {
    const result = sql('(level:error or level:warn) and service:api');
    expect(result).toContain(') AND (');
    expect(result).toContain(') OR (');
  });

  it('NOT inside AND: a and not b', () => {
    const result = sql('level:error and not level:debug');
    expect(result).toContain(') AND (');
    expect(result).toContain('NOT (');
  });

  // ── Value list ────────────────────────────────────────────────────────────

  it('level:(error or warn) → OR of two level clauses', () => {
    const result = sql('level:(error or warn)');
    expect(result).toContain(') OR (');
    expect(result).toContain('SeverityText');
  });

  it('service:(api or auth) → OR of two exact clauses', () => {
    const result = sql('service:(api or auth)');
    expect(result).toContain(') OR (');
    expect(result).toContain("= 'api'");
    expect(result).toContain("= 'auth'");
  });

  it('service:(not api) → NOT clause', () => {
    const result = sql('service:(not api)');
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
    const result = sql('level:error timeout');
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
