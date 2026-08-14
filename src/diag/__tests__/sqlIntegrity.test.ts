import { checkSqlIntegrity, detectTruncation, extractLimit } from '../sqlIntegrity';

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

  it('returns no findings for an unremarkable query', () => {
    expect(checkSqlIntegrity('SELECT * FROM t WHERE x = 1 LIMIT 100')).toHaveLength(0);
  });

  it('can return multiple findings for one query', () => {
    const findings = checkSqlIntegrity(`SELECT 1 FROM t SAMPLE 0.5 SETTINGS timeout_overflow_mode = 'break'`);
    expect(findings.map((f) => f.kind).sort()).toEqual(['overflowBreak', 'sample']);
  });
});
