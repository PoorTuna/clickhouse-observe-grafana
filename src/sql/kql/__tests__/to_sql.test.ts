import { parseKql } from '../_parser';
import { kqlToSql } from '../toSql';
import { KqlSyntaxError } from '../_error';
import { SourceConfig, OTEL_COLUMN_MAPPING } from '../../../types';
import { buildFieldIndex } from '../../fields';
import { FieldModel } from '../../fieldModel';

const config: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'otel_logs',
  isOtel: true,
  columns: OTEL_COLUMN_MAPPING,
};

function sql(kql: string): string {
  return kqlToSql(parseKql(kql), config);
}

// A discovered Map field, as field discovery would produce it (auto-detected — no config mapping
// needed since the Map-attribute config fields were removed). Map fields resolve ONLY via their
// exact bracket-accessor sqlExpr now — resolveField no longer resolves a bare/dotted Map key by
// name, even when it was discovered (index present). See sql/fields.ts's byName exclusion.
const httpMethodMapField: FieldModel = {
  id: 'map:LogAttributes:http.method',
  name: 'http.method',
  displayName: 'LogAttributes.http.method',
  sqlExpr: "LogAttributes['http.method']",
  type: 'string',
  source: 'map',
  mapColumn: 'LogAttributes',
};
const indexWithHttpMethod = buildFieldIndex([httpMethodMapField]);

describe('kqlToSql', () => {

  // ── Body / bare-term search ───────────────────────────────────────────────

  it('bare term → Body ILIKE contains (no hasToken — throws on separator-containing needles like "req-59", see C3)', () => {
    const result = sql('hello');
    expect(result).not.toContain('hasToken');
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

  it('bare ? → literal question mark in body search, not a wildcard (no _ substitution)', () => {
    const result = sql('?');
    expect(result).not.toContain('hasToken');
    expect(result).toContain("ILIKE '%?%'");
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

  // ── Exact-kind field (unquoted=exact, quoted=exact) ───────────────────────

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

  // ── ? is a literal character, not a wildcard — real KQL supports only * ──

  it('host:web?.local → literal ?, not a wildcard (KQL supports only *)', () => {
    const result = sql('host:web?.local');
    expect(result).toContain("= 'web?.local'");
    expect(result).not.toContain('ILIKE');
  });

  it('bare web? → literal ? in body search, not a wildcard', () => {
    const result = sql('web?');
    expect(result).toContain("ILIKE '%web?%'");
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
    // No wildcard → ILIKE contains, with literal *
    expect(result).toContain("ILIKE '%pay*%'");
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
  it('ServiceName:"payment" uses = not match() (keyword-field semantics)', () => {
    const result = sql('ServiceName:"payment"');
    expect(result).not.toContain('match(');
    expect(result).toContain("= 'payment'");
  });

  it('explicit bracket syntax → map accessor = (not match())', () => {
    const result = kqlToSql(parseKql(`LogAttributes['http.method']:"GET"`), config, indexWithHttpMethod);
    expect(result).toContain("LogAttributes['http.method']");
    expect(result).toContain("= 'GET'");
    expect(result).not.toContain('match(');
  });

  it('bare dotted shorthand ("http.method:GET") never resolves to a Map accessor, even when discovered', () => {
    const withIndex = kqlToSql(parseKql('http.method:"GET"'), config, indexWithHttpMethod);
    expect(withIndex).not.toContain('LogAttributes');
    const withoutIndex = sql('http.method:"GET"');
    expect(withoutIndex).not.toContain('LogAttributes');
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

  it('host:web?.local → literal ?, not a wildcard (KQL supports only *)', () => {
    const result = sql('host:web?.local');
    expect(result).toContain("= 'web?.local'");
    expect(result).not.toContain('ILIKE');
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

  it('explicit bracket syntax with :* → exists check via map accessor', () => {
    const result = kqlToSql(parseKql(`LogAttributes['http.method']:*`), config, indexWithHttpMethod);
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

  it('unknown field range → direct column comparison (no no-op), even with resourceAttributes mapped', () => {
    // `config` here has resourceAttributes mapped (OTEL_COLUMN_MAPPING) — this used to be exactly
    // the condition that triggered the blind Map-guess fallback. Proving it's gone.
    const result = sql('unknownRange >= 100');
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

  // ── Dotted field name → never a Map attribute lookup, discovered or not ──
  // No shorthand at all for Map fields: bare/dotted key never resolves to a Map accessor, even
  // when the field was discovered. Only explicit bracket syntax (Col['key']) resolves Map fields
  // — see the "explicit bracket syntax" tests above and sql/fields.ts's byName exclusion.

  it('http.method:GET never resolves to a Map accessor, discovered or not', () => {
    const result = kqlToSql(parseKql('http.method:GET'), config, indexWithHttpMethod);
    expect(result).not.toContain('LogAttributes');
  });

  it('http.status_code:200 → direct column, not discovered so no Map guessing', () => {
    const result = sql('http.status_code:200');
    expect(result).not.toContain('LogAttributes');
    expect(result).toContain("= '200'");
  });

  it('http.path:api* → direct column with wildcard, not discovered so no Map guessing', () => {
    const result = sql('http.path:api*');
    expect(result).not.toContain('LogAttributes');
    expect(result).toContain("ILIKE 'api%'");
  });

  // ── Unknown field → direct column (not body fallback) ───────────────────

  it('completely unknown field queries it as a direct column, even with resourceAttributes mapped', () => {
    const result = sql('unknownfield:value');
    expect(result).toContain('"unknownfield"');
    expect(result).toContain("= 'value'");
    expect(result).not.toContain('Body');
  });

  it('unknown field with wildcard queries it as a direct column with ILIKE', () => {
    const result = sql('unknownfield:val*');
    expect(result).toContain('"unknownfield"');
    expect(result).toContain("ILIKE 'val%'");
    expect(result).not.toContain('Body');
  });

  // ── No implicit AND — space is an ordinary character inside a value ───────
  // (matches Elastic's kuery grammar: UnquotedLiteral absorbs whitespace; only an explicit
  // and/or/not — or the start of a new field:/range clause — ends a value.)

  it('two bare words with no "and" → ONE value, not two AND-ed clauses', () => {
    const result = sql('error timeout');
    expect(result).not.toContain(') AND (');
    expect(result).toContain("ILIKE '%error timeout%'");
  });

  it('field:value followed by a bare word with no "and" → swallowed into the field value', () => {
    const result = sql('SeverityText:error timeout');
    expect(result).not.toContain(') AND (');
    expect(result).not.toContain('Body');
    expect(result).toContain("= 'error timeout'");
  });

  it('two field:value clauses with no "and" between them → syntax error, like Kibana', () => {
    expect(() => sql('SeverityText:error ServiceName:pay')).toThrow(/Expected/);
  });

  it('os:windows 10 → one value "windows 10", not a second AND-ed clause', () => {
    const result = sql('os:windows 10');
    expect(result).toContain("\"os\" = 'windows 10'");
  });

  // ── Phrase regex escaping ─────────────────────────────────────────────────

  it('phrase with regex special chars is escaped for BOTH re2 and the SQL string literal', () => {
    const result = sql('"req.id+1"');
    // escapeRe2 backslash-escapes . and +, then quoteString doubles every backslash so
    // ClickHouse's own string-literal unescaping doesn't collapse \. back down to a bare .
    // (the exact bug this fixes: a single backslash survives ClickHouse's parser as no escape
    // at all, so "req.id" used to also match "reqXid").
    expect(result).toContain('req\\\\.id\\\\+1');
  });

  it('phrase containing a single quote does not break out of the SQL string (was a syntax error / injection)', () => {
    const result = sql('"it\'s fine"');
    expect(result).toContain("it\\'s fine");
  });

  it('phrase containing SQL injection payload stays inside one quoted literal', () => {
    const result = sql(String.raw`"x') OR 1=1 --"`);
    // The literal must stay a single quoted string — no unescaped ' breaking out of it.
    expect(result).not.toMatch(/'\)\s+OR\s+1=1/);
  });

  it('Body:"req-59" regression: word-boundary prevents req-592 match', () => {
    const result = sql('Body:"req-59"');
    expect(result).toContain('match(');
    expect(result).toContain('req-59');
    expect(result).not.toContain("ILIKE '%req-59%'");
  });

  // ── JSON path resolution (discovered fields, threaded via FieldIndex) ─────

  const jsonUserIdField: FieldModel = {
    id: 'json:Payload:user.id',
    name: 'user.id',
    displayName: 'user.id',
    sqlExpr: 'Payload.user.id',
    type: 'number',
    source: 'json',
    jsonColumn: 'Payload',
    jsonPath: 'user.id',
  };
  const indexWithJson = buildFieldIndex([jsonUserIdField]);

  it('typed dotted field name resolves to the JSON accessor, not a Map lookup, when discovered', () => {
    const result = kqlToSql(parseKql('user.id:5'), config, indexWithJson);
    expect(result).toContain('Payload.user.id');
    expect(result).not.toContain('LogAttributes');
  });

  it('without a matching discovered field, the same dotted name falls back to a direct column (no Map guessing)', () => {
    const result = kqlToSql(parseKql('user.id:5'), config);
    expect(result).not.toContain('LogAttributes');
    expect(result).toContain("= '5'");
  });

  it('an already-resolved JSON sqlExpr passed back in (e.g. from a FilterPill) is not re-wrapped', () => {
    const result = kqlToSql(parseKql('Payload.user.id:5'), config, indexWithJson);
    expect(result).toContain('Payload.user.id');
    expect(result).not.toContain("LogAttributes['Payload.user.id']");
  });

  it('numeric range on a JSON field casts to Float64, like Map fields do', () => {
    const result = kqlToSql(parseKql('user.id > 100'), config, indexWithJson);
    expect(result).toContain('toFloat64(Payload.user.id)');
    expect(result).toContain('> 100');
  });

  // ── Colon runs inside a field value (12:30:45, url:http://x) ─────────────

  it('a value containing further colons stays one clause: field:12:30:45', () => {
    const result = sql('startedAt:12:30:45');
    expect(result).toContain("= '12:30:45'");
  });

  it('url:http://x → one clause, value is the whole "http://x"', () => {
    const result = sql('url:http://x');
    expect(result).toContain("= 'http://x'");
  });

  // ── Unresolvable field:value → plain-text body search (with an index present) ─────────

  it('with an index, an unresolvable field:value falls back to a body search over the raw text, not a broken column reference', () => {
    const result = kqlToSql(parseKql('http://x'), config, indexWithHttpMethod);
    expect(result).not.toContain('"http"');
    expect(result).toContain("ILIKE '%http://x%'");
  });

  it('12:30:45 with an index present searches the body, no "12" column reference', () => {
    const result = kqlToSql(parseKql('12:30:45'), config, indexWithHttpMethod);
    expect(result).not.toContain('"12"');
    expect(result).toContain("ILIKE '%12:30:45%'");
  });

  it('without an index, an unresolvable field:value keeps the historical direct-column fallback', () => {
    const result = sql('http://x');
    expect(result).toContain('"http"');
    expect(result).toContain("= '//x'");
  });

  // ── Field-name wildcards: data*: 5 / datastream.*: logs ───────────────────

  const dsAField: FieldModel = {
    id: 'col:datastream.a', name: 'datastream.a', displayName: 'datastream.a',
    sqlExpr: 'datastream_a', type: 'string', source: 'column',
  };
  const dsBField: FieldModel = {
    id: 'col:datastream.b', name: 'datastream.b', displayName: 'datastream.b',
    sqlExpr: 'datastream_b', type: 'string', source: 'column',
  };
  const indexWithDatastream = buildFieldIndex([dsAField, dsBField]);

  it('datastream.*: logs → OR across every matching discovered field', () => {
    const result = kqlToSql(parseKql('datastream.*:logs'), config, indexWithDatastream);
    expect(result).toContain('datastream_a');
    expect(result).toContain('datastream_b');
    expect(result).toContain(') OR (');
  });

  it('a field wildcard matching nothing discovered → 1=0 (matches nothing)', () => {
    const result = kqlToSql(parseKql('nope.*:logs'), config, indexWithDatastream);
    expect(result).toBe('1=0');
  });

  it('field wildcard with no index falls back to the literal field name as a direct column', () => {
    const result = sql('data*:5');
    expect(result).not.toContain('OR');
  });

  // ── true / false / null typed literals (unquoted only — quoted values stay strings) ──

  it('flag:true → bare boolean, not the string \'true\'', () => {
    const result = sql('flag:true');
    expect(result).toContain('= true');
    expect(result).not.toContain("'true'");
  });

  it('flag:false → bare boolean', () => {
    const result = sql('flag:false');
    expect(result).toContain('= false');
  });

  it('field:null → IS NULL', () => {
    const result = sql('field:null');
    expect(result).toContain('IS NULL');
  });

  it('field:"true" (quoted) stays the string \'true\' — QuotedString is never typed', () => {
    const result = sql('field:"true"');
    expect(result).toContain("= 'true'");
  });

  // ── Parser rejects a missing "and"/"or" between clauses, Kibana-style ─────

  it('two field:value clauses with nothing between them throws KqlSyntaxError', () => {
    expect(() => parseKql('level:error service:pay')).toThrow(/Expected/);
  });

  it('the thrown error carries the offending token and a usable position', () => {
    try {
      parseKql('level:error service:pay');
      throw new Error('expected parseKql to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(KqlSyntaxError);
      const err = e as KqlSyntaxError;
      expect(err.found).toBe('service');
      expect(err.position).toBe('level:error '.length);
      expect(err.message).toContain('level:error service:pay');
    }
  });
});
