import { lex, WILDCARD_STAR, WILDCARD_QMARK, WILDCARD_RE } from '../_lexer';

// Convenience: get the token types from a string
function types(input: string) {
  return lex(input).map((t) => t.type);
}

// Convenience: get the string values of IDENT and QUOTED tokens only
function values(input: string) {
  return lex(input)
    .filter((t) => t.type === 'IDENT' || t.type === 'QUOTED')
    .map((t) => t.value);
}

describe('KQL lexer', () => {

  // ── Basic structure ────────────────────────────────────────────────────────

  it('empty string → only EOF', () => {
    const toks = lex('');
    expect(toks).toHaveLength(1);
    expect(toks[0].type).toBe('EOF');
  });

  it('whitespace-only → only EOF', () => {
    const toks = lex('   \t\n  ');
    expect(toks).toHaveLength(1);
    expect(toks[0].type).toBe('EOF');
  });

  it('simple IDENT', () => {
    expect(types('hello')).toEqual(['IDENT', 'EOF']);
    expect(values('hello')).toEqual(['hello']);
  });

  // ── Punctuation ───────────────────────────────────────────────────────────

  it('colon', () => {
    expect(types(':')).toEqual(['COLON', 'EOF']);
  });

  it('parens', () => {
    expect(types('()')).toEqual(['LPAREN', 'RPAREN', 'EOF']);
  });

  it('braces', () => {
    expect(types('{}')).toEqual(['LBRACE', 'RBRACE', 'EOF']);
  });

  it('range operators: > >= < <=', () => {
    expect(types('>')).toEqual(['GT', 'EOF']);
    expect(types('>=')).toEqual(['GTE', 'EOF']);
    expect(types('<')).toEqual(['LT', 'EOF']);
    expect(types('<=')).toEqual(['LTE', 'EOF']);
  });

  it('field:value tokenizes to IDENT COLON IDENT', () => {
    expect(types('level:error')).toEqual(['IDENT', 'COLON', 'IDENT', 'EOF']);
    expect(values('level:error')).toEqual(['level', 'error']);
  });

  // ── Token positions ────────────────────────────────────────────────────────

  it('token start/end positions are correct', () => {
    const toks = lex('a:b').filter((t) => t.type !== 'EOF');
    expect(toks[0]).toMatchObject({ type: 'IDENT', value: 'a', start: 0, end: 1 });
    expect(toks[1]).toMatchObject({ type: 'COLON', value: ':', start: 1, end: 2 });
    expect(toks[2]).toMatchObject({ type: 'IDENT', value: 'b', start: 2, end: 3 });
  });

  it('positions account for leading whitespace', () => {
    const toks = lex('  foo').filter((t) => t.type !== 'EOF');
    expect(toks[0]).toMatchObject({ start: 2, end: 5 });
  });

  // ── Keywords ──────────────────────────────────────────────────────────────

  it('and / AND → AND token', () => {
    expect(types('and')).toEqual(['AND', 'EOF']);
    expect(types('AND')).toEqual(['AND', 'EOF']);
    expect(types('And')).toEqual(['AND', 'EOF']);
  });

  it('or / OR → OR token', () => {
    expect(types('or')).toEqual(['OR', 'EOF']);
    expect(types('OR')).toEqual(['OR', 'EOF']);
  });

  it('not / NOT → NOT token', () => {
    expect(types('not')).toEqual(['NOT', 'EOF']);
    expect(types('NOT')).toEqual(['NOT', 'EOF']);
  });

  it('keyword-like words stay IDENT', () => {
    expect(types('android')).toEqual(['IDENT', 'EOF']);
    expect(types('order')).toEqual(['IDENT', 'EOF']);
    expect(types('nothing')).toEqual(['IDENT', 'EOF']);
    expect(types('annotation')).toEqual(['IDENT', 'EOF']);
    expect(types('notable')).toEqual(['IDENT', 'EOF']);
  });

  it('multi-token: level:error and service:api', () => {
    expect(types('level:error and service:api')).toEqual([
      'IDENT', 'COLON', 'IDENT', 'AND', 'IDENT', 'COLON', 'IDENT', 'EOF',
    ]);
  });

  // ── Quoted strings ────────────────────────────────────────────────────────

  it('double-quoted phrase → QUOTED token', () => {
    expect(types('"hello world"')).toEqual(['QUOTED', 'EOF']);
    expect(values('"hello world"')).toEqual(['hello world']);
  });

  it('quoted string with escaped double-quote', () => {
    const toks = lex('"he said \\"hi\\""');
    expect(toks[0].type).toBe('QUOTED');
    expect(toks[0].value).toBe('he said "hi"');
  });

  it('quoted string with escape sequences \\t \\n', () => {
    const toks = lex('"a\\tb\\nc"');
    expect(toks[0].value).toBe('a\tb\nc');
  });

  it('unterminated quote → QUOTED token up to EOF', () => {
    const toks = lex('"hello');
    expect(toks[0].type).toBe('QUOTED');
    expect(toks[0].value).toBe('hello');
  });

  it('quoted string: * inside quotes is literal (no sentinel)', () => {
    const toks = lex('"pay*ment"');
    expect(toks[0].type).toBe('QUOTED');
    // The * inside a quoted string stays as a literal * — NOT a sentinel
    expect(toks[0].value).toBe('pay*ment');
    expect(WILDCARD_RE.test(toks[0].value)).toBe(false);
  });

  // ── Wildcard sentinels ────────────────────────────────────────────────────

  it('unescaped * → IDENT containing WILDCARD_STAR sentinel', () => {
    const toks = lex('pay*');
    expect(toks[0].type).toBe('IDENT');
    expect(toks[0].value).toBe('pay' + WILDCARD_STAR);
    expect(WILDCARD_RE.test(toks[0].value)).toBe(true);
  });

  it('unescaped ? → IDENT containing WILDCARD_QMARK sentinel', () => {
    const toks = lex('web?');
    expect(toks[0].type).toBe('IDENT');
    expect(toks[0].value).toBe('web' + WILDCARD_QMARK);
    expect(WILDCARD_RE.test(toks[0].value)).toBe(true);
  });

  it('bare * → IDENT with only WILDCARD_STAR (used for field:* exists)', () => {
    const toks = lex('*');
    expect(toks[0].type).toBe('IDENT');
    expect(toks[0].value).toBe(WILDCARD_STAR);
  });

  it('leading wildcard *foo → sentinel + foo', () => {
    const toks = lex('*foo');
    expect(toks[0].value).toBe(WILDCARD_STAR + 'foo');
  });

  it('infix wildcard f*o → f + sentinel + o', () => {
    const toks = lex('f*o');
    expect(toks[0].value).toBe('f' + WILDCARD_STAR + 'o');
  });

  it('multiple wildcards *err* → sentinel err sentinel', () => {
    const toks = lex('*err*');
    expect(toks[0].value).toBe(WILDCARD_STAR + 'err' + WILDCARD_STAR);
  });

  it('mixed wildcards fo*ar? → f o sentinel a r sentinel', () => {
    const toks = lex('fo*ar?');
    expect(toks[0].value).toBe('fo' + WILDCARD_STAR + 'ar' + WILDCARD_QMARK);
  });

  // ── Escaped wildcards and keywords ────────────────────────────────────────

  it('escaped \\* → literal asterisk, NO sentinel', () => {
    const toks = lex('\\*');
    expect(toks[0].type).toBe('IDENT');
    expect(toks[0].value).toBe('*');
    expect(WILDCARD_RE.test(toks[0].value)).toBe(false);
  });

  it('escaped \\? → literal question mark, NO sentinel', () => {
    const toks = lex('\\?');
    expect(toks[0].type).toBe('IDENT');
    expect(toks[0].value).toBe('?');
    expect(WILDCARD_RE.test(toks[0].value)).toBe(false);
  });

  it('escaped \\and → IDENT (not AND keyword)', () => {
    expect(types('\\and')).toEqual(['IDENT', 'EOF']);
    expect(values('\\and')).toEqual(['and']);
  });

  it('escaped \\or → IDENT (not OR keyword)', () => {
    expect(types('\\or')).toEqual(['IDENT', 'EOF']);
  });

  it('escaped \\not → IDENT (not NOT keyword)', () => {
    expect(types('\\not')).toEqual(['IDENT', 'EOF']);
  });

  it('pay\\*ment → literal pay*ment with no sentinel (not a wildcard)', () => {
    const toks = lex('pay\\*ment');
    expect(toks[0].type).toBe('IDENT');
    expect(toks[0].value).toBe('pay*ment');
    expect(WILDCARD_RE.test(toks[0].value)).toBe(false);
  });

  it('mixed: pay\\*ment* → literal asterisk + wildcard sentinel', () => {
    // pay\*ment* → chars: p a y * m e n t <WILDCARD_STAR>
    // \* → literal *, * → sentinel
    const toks = lex('pay\\*ment*');
    expect(toks[0].value).toBe('pay*ment' + WILDCARD_STAR);
    expect(WILDCARD_RE.test(toks[0].value)).toBe(true);
  });

  // ── WILDCARD_STAR / WILDCARD_QMARK constants ──────────────────────────────

  it('WILDCARD_STAR is a single char', () => {
    expect(WILDCARD_STAR).toHaveLength(1);
    expect(WILDCARD_STAR.charCodeAt(0)).toBe(0xE000);
  });

  it('WILDCARD_QMARK is a single char', () => {
    expect(WILDCARD_QMARK).toHaveLength(1);
    expect(WILDCARD_QMARK.charCodeAt(0)).toBe(0xE001);
  });

  it('WILDCARD_RE matches both sentinels', () => {
    expect(WILDCARD_RE.test(WILDCARD_STAR)).toBe(true);
    expect(WILDCARD_RE.test(WILDCARD_QMARK)).toBe(true);
    expect(WILDCARD_RE.test('*')).toBe(false);
    expect(WILDCARD_RE.test('?')).toBe(false);
    expect(WILDCARD_RE.test('foo')).toBe(false);
  });
});
