import { __resetForTests, startAction } from '../tracer';
import { computeWarnings } from '../warnings';

beforeEach(() => {
  __resetForTests();
});

describe('computeWarnings', () => {
  it('returns no warnings for a clean action', () => {
    const action = startAction('Search submit');
    const logs = action.child('logs', 'logs');
    logs.setAttrs({ sql: 'SELECT * FROM t WHERE x = 1 LIMIT 100' });
    logs.end('ok');
    action.end('ok');

    expect(computeWarnings(action.span)).toEqual([]);
  });

  it("flags a query using overflow_mode = 'break'", () => {
    const action = startAction('Search submit');
    const volume = action.child('volume', 'volume');
    volume.setAttrs({ sql: `SELECT 1 SETTINGS timeout_overflow_mode = 'break'` });
    volume.end('ok');

    const warnings = computeWarnings(action.span);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe('warning');
    expect(warnings[0].message).toContain('volume');
  });

  it('prefers executedSql over sql when both are present (post-macro SQL is the real thing that ran)', () => {
    const action = startAction('a');
    const q = action.child('logs', 'logs');
    q.setAttrs({ sql: 'SELECT 1', executedSql: `SELECT 1 SETTINGS timeout_overflow_mode = 'break'` });
    q.end('ok');

    expect(computeWarnings(action.span)).toHaveLength(1);
  });

  it('flags a truncated query as info for an op with no pagination UI of its own', () => {
    const action = startAction('a');
    const q = action.child('mapKeys', 'mapKeys');
    q.setAttrs({ sql: 'SELECT 1 LIMIT 100', truncated: true });
    q.end('ok');

    const warnings = computeWarnings(action.span);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe('info');
    expect(warnings[0].message).toMatch(/capped/i);
  });

  it('does not flag a query explicitly marked not truncated', () => {
    const action = startAction('a');
    const q = action.child('mapKeys', 'mapKeys');
    q.setAttrs({ sql: 'SELECT 1 LIMIT 100', truncated: false });
    q.end('ok');

    expect(computeWarnings(action.span)).toEqual([]);
  });

  // Regression (B2): the logs grid is paginated (an explicit "load more" affordance), so returning
  // exactly LIMIT rows is the expected steady state of a healthy fetch, not missing data. Before
  // this fix a full page permanently lit the Warnings & Errors badge on every search.
  it('does not flag a truncated "logs" query — it has its own pagination UI, a full page is expected', () => {
    const action = startAction('a');
    const q = action.child('logs', 'logs');
    q.setAttrs({ sql: 'SELECT 1 LIMIT 50', truncated: true });
    q.end('ok');

    expect(computeWarnings(action.span)).toEqual([]);
  });

  it('does not flag a truncated "loadMore" query for the same reason', () => {
    const action = startAction('a');
    const q = action.child('loadMore', 'loadMore');
    q.setAttrs({ sql: 'SELECT 1 LIMIT 50', truncated: true });
    q.end('ok');

    expect(computeWarnings(action.span)).toEqual([]);
  });

  it('surfaces a failed span as an error-severity warning, even for spans the UI silently swallows', () => {
    const action = startAction('a');
    const loadMore = action.child('loadMore', 'loadMore');
    loadMore.setError('Timeout exceeded');
    loadMore.end('error');

    const warnings = computeWarnings(action.span);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe('error');
    expect(warnings[0].message).toContain('Timeout exceeded');
  });

  it('does not flag a cancelled span as an error', () => {
    const action = startAction('a');
    const q = action.child('logs', 'logs');
    q.end('cancelled');

    expect(computeWarnings(action.span)).toEqual([]);
  });

  it('sorts errors before warnings before info', () => {
    const action = startAction('a');
    const info = action.child('mapKeys', 'mapKeys');
    info.setAttrs({ sql: 'SELECT 1 LIMIT 1', truncated: true });
    info.end('ok');
    const warn = action.child('volume', 'volume');
    warn.setAttrs({ sql: `SETTINGS timeout_overflow_mode = 'break'` });
    warn.end('ok');
    const err = action.child('detailRow', 'detailRow');
    err.setError('boom');
    err.end('error');

    const warnings = computeWarnings(action.span);
    expect(warnings.map((w) => w.severity)).toEqual(['error', 'warning', 'info']);
  });

  it('flags a server-recorded exception that the client-side status never reflected', () => {
    const action = startAction('a');
    const q = action.child('logs', 'logs');
    q.setAttrs({ sql: 'SELECT 1', serverExceptionCode: 60, serverException: 'Unknown table' });
    q.end('ok'); // client saw success — the datasource swallowed/misreported the server error

    const warnings = computeWarnings(action.span);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe('error');
    expect(warnings[0].message).toContain('Unknown table');
  });

  it('does not double-flag a server exception when the span already ended in error client-side', () => {
    const action = startAction('a');
    const q = action.child('logs', 'logs');
    q.setAttrs({ sql: 'SELECT 1', serverExceptionCode: 60 });
    q.setError('Unknown table');
    q.end('error');

    const warnings = computeWarnings(action.span);
    // Only the ordinary failed-span warning, not a second "server exception" one — the client
    // already reported this failure correctly.
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).not.toContain('ClickHouse recorded an exception');
  });

  it('finds warnings anywhere in a nested subtree, not just direct children of the root', () => {
    const action = startAction('a');
    const query = action.child('logs', 'logs');
    const nested = query.child('detailRow', 'detailRow');
    nested.setAttrs({ sql: `SETTINGS timeout_overflow_mode = 'break'` });
    nested.end('ok');

    expect(computeWarnings(action.span)).toHaveLength(1);
  });
});
