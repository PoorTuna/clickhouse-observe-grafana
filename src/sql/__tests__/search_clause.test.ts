/**
 * End-to-end tests for the KQL → SQL path through buildWhereConditions.
 * Exercises the full stack: KQL string → parseKql → kqlToSql → WHERE clause.
 */
import { buildWhereConditions } from '../queryBuilder';
import { SourceConfig, OTEL_COLUMN_MAPPING, DEFAULT_LOGS_QUERY_STATE } from '../../types';

const config: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'otel_logs',
  isOtel: true,
  columns: OTEL_COLUMN_MAPPING,
};

function conditions(search: string): string[] {
  return buildWhereConditions(config, { ...DEFAULT_LOGS_QUERY_STATE, search });
}

describe('buildWhereConditions — search clause', () => {

  // ── Empty / whitespace ────────────────────────────────────────────────────

  it('empty search string → no search condition added', () => {
    const conds = conditions('');
    // Only the timestamp condition should be present
    expect(conds).toHaveLength(1);
    expect(conds[0]).toContain('$__fromTime');
  });

  it('whitespace-only search → no search condition', () => {
    const conds = conditions('   ');
    expect(conds).toHaveLength(1);
  });

  // ── Valid KQL is translated ───────────────────────────────────────────────

  it('valid KQL term → search condition is appended', () => {
    const conds = conditions('error');
    expect(conds).toHaveLength(2);
    expect(conds[1]).toContain('Body');
  });

  it('SeverityText:error → exact match in conditions (no alias, no IN-list)', () => {
    const conds = conditions('SeverityText:error');
    expect(conds).toHaveLength(2);
    expect(conds[1]).toContain('SeverityText');
    expect(conds[1]).toContain("= 'error'");
  });

  it('wildcard pay* → ILIKE in conditions', () => {
    const conds = conditions('pay*');
    expect(conds).toHaveLength(2);
    expect(conds[1]).toContain("ILIKE 'pay%'");
  });

  it('combined KQL: level:error and service:api → AND in conditions', () => {
    const conds = conditions('level:error and service:api');
    expect(conds).toHaveLength(2);
    expect(conds[1]).toContain(') AND (');
  });

  // ── Parse error → legacy fallback (never throws) ─────────────────────────

  it('malformed KQL: lone AND → falls back, does not throw', () => {
    expect(() => conditions('AND')).not.toThrow();
    // Legacy fallback searches body for the literal token
    const conds = conditions('level:error AND');
    // Should not throw; parser will either handle it or fall back
    expect(conds.length).toBeGreaterThanOrEqual(1);
  });

  it('empty parens () → falls back or handles gracefully, does not throw', () => {
    expect(() => conditions('()')).not.toThrow();
  });

  // ── Filters are also included ─────────────────────────────────────────────

  it('search + filter → both conditions present', () => {
    const conds = buildWhereConditions(config, {
      ...DEFAULT_LOGS_QUERY_STATE,
      search: 'error',
      filters: [{ id: 'f1', field: 'ServiceName', op: '=', value: 'api' }],
    });
    // timestamp + search + filter = 3
    expect(conds).toHaveLength(3);
  });

  it('only filter (no search) → timestamp + filter = 2', () => {
    const conds = buildWhereConditions(config, {
      ...DEFAULT_LOGS_QUERY_STATE,
      search: '',
      filters: [{ id: 'f1', field: 'ServiceName', op: '=', value: 'api' }],
    });
    expect(conds).toHaveLength(2);
  });
});
