import { checkSqlIntegrity, detectTruncation, extractLimit, stripLiterals } from '../sqlIntegrity';

describe('extractLimit', () => {
  it('extracts a plain LIMIT', () => {
    expect(extractLimit('SELECT 1 FROM t LIMIT 500')).toBe(500);
  });

  it('extracts the row cap from LIMIT n OFFSET m, not the offset', () => {
    expect(extractLimit('SELECT 1 FROM t LIMIT 500 OFFSET 1000')).toBe(500);
  });

  it('returns undefined when there is no LIMIT', () => {
    expect(extractLimit('SELECT 1 FROM t')).toBeUndefined();
  });

  // Regression (B8): queryBuilder.ts's field-value sampler nests an inner `LIMIT sampleSize`
  // before its own outer `LIMIT limit` — the FIRST match belongs to the subquery, not the whole
  // query's real cap.
  it('takes the last LIMIT, not the first, when a subquery has its own', () => {
    const sql = `SELECT v FROM (SELECT v FROM t LIMIT 500) sub GROUP BY v ORDER BY count() DESC LIMIT 10`;
    expect(extractLimit(sql)).toBe(10);
  });

  it('ignores a LIMIT-shaped number that only appears inside a quoted string literal', () => {
    expect(extractLimit(`SELECT 1 FROM t WHERE msg = 'LIMIT 999'`)).toBeUndefined();
  });
});

describe('stripLiterals', () => {
  it('replaces an arbitrary string literal with a placeholder', () => {
    expect(stripLiterals(`WHERE x = 'super-secret'`)).toBe(`WHERE x = '<redacted>'`);
  });

  it('keeps the small allowlist of ClickHouse keyword values untouched', () => {
    const sql = `SETTINGS timeout_overflow_mode = 'throw', group_by_overflow_mode = 'any'`;
    expect(stripLiterals(sql)).toBe(sql);
  });

  it('strips line and block comments', () => {
    expect(stripLiterals('SELECT 1 -- trailing comment\nFROM t')).not.toContain('trailing comment');
    expect(stripLiterals('SELECT /* inline */ 1 FROM t')).not.toContain('inline');
  });
});

describe('detectTruncation', () => {
  it('is true when rowCount reaches the LIMIT', () => {
    expect(detectTruncation('SELECT 1 FROM t LIMIT 500', 500)).toBe(true);
  });

  it('is false when rowCount is under the LIMIT', () => {
    expect(detectTruncation('SELECT 1 FROM t LIMIT 500', 12)).toBe(false);
  });

  it('is undefined (not false) when the query has no LIMIT at all', () => {
    expect(detectTruncation('SELECT 1 FROM t', 12)).toBeUndefined();
  });
});

describe('checkSqlIntegrity', () => {
  it('flags timeout_overflow_mode = break', () => {
    const findings = checkSqlIntegrity(`SELECT 1 SETTINGS timeout_overflow_mode = 'break'`);
    expect(findings.map((f) => f.kind)).toContain('overflowBreak');
  });

  it('flags read_overflow_mode and result_overflow_mode the same way', () => {
    expect(checkSqlIntegrity(`SETTINGS read_overflow_mode = 'break'`).map((f) => f.kind)).toContain('overflowBreak');
    expect(checkSqlIntegrity(`SETTINGS result_overflow_mode = 'break'`).map((f) => f.kind)).toContain('overflowBreak');
  });

  it('does not flag overflow_mode = throw', () => {
    const findings = checkSqlIntegrity(`SETTINGS timeout_overflow_mode = 'throw'`);
    expect(findings).toHaveLength(0);
  });

  it('flags group_by_overflow_mode = any', () => {
    const findings = checkSqlIntegrity(`SETTINGS group_by_overflow_mode = 'any'`);
    expect(findings.map((f) => f.kind)).toContain('groupByAny');
  });

  it('flags SAMPLE usage', () => {
    const findings = checkSqlIntegrity('SELECT count() FROM t SAMPLE 0.1');
    expect(findings.map((f) => f.kind)).toContain('sample');
  });

  // Regression (B8): searching for the literal word "sample" (e.g. Body LIKE '%sample%') must not
  // be mistaken for the SQL SAMPLE clause — the word only means something as unquoted SQL syntax.
  it('does not flag the word "sample" when it only appears inside a quoted string literal', () => {
    const findings = checkSqlIntegrity(`SELECT * FROM t WHERE Body LIKE '%sample%'`);
    expect(findings.map((f) => f.kind)).not.toContain('sample');
  });

  it('returns no findings for an unremarkable query', () => {
    expect(checkSqlIntegrity('SELECT * FROM t WHERE x = 1 LIMIT 100')).toHaveLength(0);
  });

  it('can return multiple findings for one query', () => {
    const findings = checkSqlIntegrity(`SELECT 1 FROM t SAMPLE 0.5 SETTINGS timeout_overflow_mode = 'break'`);
    expect(findings.map((f) => f.kind).sort()).toEqual(['overflowBreak', 'sample']);
  });
});
