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
  // partitionTimestamp explicitly off ('-') — this file tests search-clause construction, not the
  // coarse index-pruning predicate (see prune_column.test.ts / build_logs_query.test.ts for that),
  // so an unrelated extra WHERE condition would just be noise against every assertion below.
  columns: { ...OTEL_COLUMN_MAPPING, partitionTimestamp: '-' },
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

  // ── Parse error → propagates, no silent legacy fallback ──────────────────
  // buildSearchClause used to swallow any KqlSyntaxError and quietly re-tokenize into an ANDed
  // body ILIKE chain — a query that means something different from what was typed. It now lets
  // the error propagate; callers (SearchBar.commit(), LogsExplorer's fetch effects) are
  // responsible for catching it and showing the parse error instead of silently searching
  // something else. See queryBuilder.ts's buildSearchClause doc comment.

  it('malformed KQL: lone AND → throws KqlSyntaxError', () => {
    expect(() => conditions('AND')).toThrow();
    expect(() => conditions('level:error AND')).toThrow();
  });

  it('empty parens () → throws KqlSyntaxError', () => {
    expect(() => conditions('()')).toThrow();
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
