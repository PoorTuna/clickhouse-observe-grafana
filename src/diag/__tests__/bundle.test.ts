import { __resetForTests, startAction } from '../tracer';
import { buildDiagnosticsBundle, redactConfig, redactSql } from '../bundle';
import { EMPTY_COLUMN_MAPPING, SourceConfig } from '../../types';

beforeEach(() => {
  __resetForTests();
});

describe('redactSql', () => {
  it('redacts a WHERE clause literal — the exact thing a user searched for', () => {
    const sql = `SELECT * FROM t WHERE Body LIKE '%secret-customer-email@example.com%'`;
    expect(redactSql(sql)).toBe(`SELECT * FROM t WHERE Body LIKE '<redacted>'`);
  });

  it('redacts multiple literals in one query', () => {
    const sql = `SELECT * FROM t WHERE a = 'value-one' AND b = 'value-two'`;
    expect(redactSql(sql)).toBe(`SELECT * FROM t WHERE a = '<redacted>' AND b = '<redacted>'`);
  });

  it('keeps the small allowlist of ClickHouse keyword values this codebase itself emits', () => {
    const sql = `SELECT 1 SETTINGS timeout_overflow_mode = 'throw', read_overflow_mode = 'break'`;
    expect(redactSql(sql)).toBe(sql); // unchanged — both values are on the allowlist
  });

  it('redacts a value that happens to collide with nothing on the allowlist even if short', () => {
    expect(redactSql(`WHERE x = 'ok'`)).toBe(`WHERE x = '<redacted>'`);
  });

  it('does not touch numeric literals, identifiers, or non-quoted SQL', () => {
    const sql = `SELECT count() FROM t WHERE x = 5 AND y > 10 LIMIT 100`;
    expect(redactSql(sql)).toBe(sql);
  });

  it('handles an escaped quote inside a literal without breaking the redaction boundary', () => {
    const sql = `WHERE x = 'it\\'s a test'`;
    expect(redactSql(sql)).toBe(`WHERE x = '<redacted>'`);
  });

  it('redacts a value even when it happens to be a substring of an allowlisted one', () => {
    // 'throws' is not 'throw' — must not match the allowlist via a loose/partial comparison.
    expect(redactSql(`WHERE x = 'throws'`)).toBe(`WHERE x = '<redacted>'`);
  });
});

describe('redactConfig', () => {
  const config: SourceConfig = {
    datasourceUid: 'ds-1',
    database: 'internal_prod_db',
    logsTable: 'customer_events',
    isOtel: true,
    columns: { ...EMPTY_COLUMN_MAPPING, timestamp: 'Timestamp', body: 'Body' },
    extraQuerySettings: 'max_replica_delay_for_distributed_queries = 30',
    clusterName: 'prod-cluster-eu',
    sequentialConsistency: false,
  };

  it('never includes the database or table name', () => {
    const redacted = redactConfig(config);
    expect(JSON.stringify(redacted)).not.toContain('internal_prod_db');
    expect(JSON.stringify(redacted)).not.toContain('customer_events');
  });

  it('never includes the raw extraQuerySettings text or cluster name, only whether they are set', () => {
    const redacted = redactConfig(config);
    expect(JSON.stringify(redacted)).not.toContain('max_replica_delay_for_distributed_queries');
    expect(JSON.stringify(redacted)).not.toContain('prod-cluster-eu');
    expect(redacted.hasExtraQuerySettings).toBe(true);
    expect(redacted.hasClusterName).toBe(true);
  });

  it('never includes the actual column names, only which logical fields are mapped', () => {
    const redacted = redactConfig(config);
    expect(JSON.stringify(redacted)).not.toContain('Timestamp');
    expect(redacted.mappedFields).toContain('timestamp');
    expect(redacted.mappedFields).toContain('body');
  });

  it('preserves structural flags useful for debugging', () => {
    const redacted = redactConfig(config);
    expect(redacted).toMatchObject({ isOtel: true, sequentialConsistency: false });
  });
});

describe('buildDiagnosticsBundle', () => {
  const config: SourceConfig = {
    datasourceUid: 'ds-1',
    database: 'internal_prod_db',
    logsTable: 'customer_events',
    isOtel: false,
    columns: { ...EMPTY_COLUMN_MAPPING },
  };

  it('redacts SQL inside the span tree, not just the top-level config', () => {
    const action = startAction('Search submit');
    const logs = action.child('logs', 'logs');
    logs.setAttrs({
      sql: `SELECT * FROM t WHERE Body LIKE '%super-secret%'`,
      executedSql: `SELECT * FROM t WHERE Body LIKE '%super-secret%' AND Timestamp >= 1700000000`,
    });
    logs.end('ok');
    action.end('ok');

    const bundle = buildDiagnosticsBundle(action.span, config);
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('internal_prod_db');
    expect(serialized).not.toContain('customer_events');
  });

  it('includes warnings, durations, and a plugin version', () => {
    const action = startAction('a');
    const q = action.child('logs', 'logs');
    q.setAttrs({ sql: `SETTINGS timeout_overflow_mode = 'break'` });
    q.end('ok');
    action.end('ok');

    const bundle = buildDiagnosticsBundle(action.span, config);
    expect(bundle.warnings.length).toBeGreaterThan(0);
    expect(bundle.root.durationMs).not.toBeNull();
    expect(typeof bundle.pluginVersion).toBe('string');
    expect(bundle.pluginVersion.length).toBeGreaterThan(0);
  });

  // Regression (B1): formatDataQueryError (runQuery.ts) routinely echoes the failing query back
  // verbatim inside .message for a ClickHouse exception, and warnings.ts's FAILED finding
  // re-embeds that same string — both bypassed redaction entirely before this fix, leaking exactly
  // the data the bundle exists to redact.
  it('redacts a searched literal that appears inside a span error, not just inside sql/executedSql', () => {
    const action = startAction('Search submit');
    const logs = action.child('logs', 'logs');
    logs.setAttrs({ sql: `SELECT * FROM t WHERE Body LIKE '%secret-value%'` });
    logs.setError(`DB::Exception: while processing query: SELECT * FROM t WHERE Body LIKE '%secret-value%'`);
    logs.end('error');
    action.end('error');

    const bundle = buildDiagnosticsBundle(action.span, config);
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('secret-value');
  });

  it('redacts a searched literal that appears inside a warning message', () => {
    const action = startAction('Search submit');
    const logs = action.child('logs', 'logs');
    logs.setAttrs({ sql: 'SELECT 1' });
    logs.setError(`ClickHouse exception near 'super-secret-token'`);
    logs.end('error');
    action.end('error');

    const bundle = buildDiagnosticsBundle(action.span, config);
    const messages = bundle.warnings.map((w) => w.message).join(' ');
    expect(messages).not.toContain('super-secret-token');
  });

  it('redacts the ClickHouse-recorded exception text (serverException attr), not just the client error', () => {
    const action = startAction('a');
    const q = action.child('logs', 'logs');
    q.setAttrs({
      sql: 'SELECT 1',
      serverExceptionCode: 60,
      serverException: `Code: 60. DB::Exception: while executing SELECT * WHERE x = 'leaked-server-side'`,
    });
    q.end('ok'); // client-side status stayed 'ok' — this is exactly the "hid a ClickHouse exception" case
    action.end('ok');

    const bundle = buildDiagnosticsBundle(action.span, config);
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('leaked-server-side');
  });

  // Related fix, same finding: redactConfig strips the database/table name from the config object,
  // but the SQL sitting next to it still said `FROM internal_prod_db.customer_events` in plain text.
  it('redacts bare (unquoted) database/table identifiers inside SQL text, not just quoted literals', () => {
    const action = startAction('a');
    const q = action.child('logs', 'logs');
    q.setAttrs({ sql: `SELECT * FROM internal_prod_db.customer_events WHERE x = 1` });
    q.end('ok');
    action.end('ok');

    const bundle = buildDiagnosticsBundle(action.span, config);
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('internal_prod_db');
    expect(serialized).not.toContain('customer_events');
  });

  it('is valid JSON end to end (no cycles, no undefined-breaking values)', () => {
    const action = startAction('a');
    const q = action.child('logs', 'logs');
    q.setAttrs({ sql: 'SELECT 1', rowCount: 5 });
    q.end('ok');
    action.end('ok');

    const bundle = buildDiagnosticsBundle(action.span, config);
    expect(() => JSON.parse(JSON.stringify(bundle))).not.toThrow();
  });
});
