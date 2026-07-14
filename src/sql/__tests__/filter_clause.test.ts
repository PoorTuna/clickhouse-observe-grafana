/**
 * Unit tests for buildFilterClause (via buildWhereConditions) covering the
 * extended FilterOp set: exists, not_exists, one_of, not_one_of.
 * Also tests filterLabel output for the new operators and custom-label override.
 */

import { buildWhereConditions } from '../queryBuilder';
import { filterLabel, addFilterPill } from '../filters';
import {
  FilterPill,
  OTEL_COLUMN_MAPPING,
  DEFAULT_LOGS_QUERY_STATE,
  SourceConfig,
} from '../../types';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const config: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'otel_logs',
  tracesTable: 'otel_traces',
  isOtel: true,
  columns: OTEL_COLUMN_MAPPING,
};

function stateWithFilter(pill: Omit<FilterPill, 'id'>): typeof DEFAULT_LOGS_QUERY_STATE {
  return {
    ...DEFAULT_LOGS_QUERY_STATE,
    filters: [{ id: 'f1', ...pill }],
  };
}

function filterClause(pill: Omit<FilterPill, 'id'>): string {
  const conditions = buildWhereConditions(config, stateWithFilter(pill));
  // Index 0 = timestamp range; index 1 = the filter clause
  return conditions[1];
}

// ── exists / not_exists ───────────────────────────────────────────────────────

describe('buildFilterClause — exists / not_exists', () => {
  it('exists → notEmpty(toString(...))', () => {
    const clause = filterClause({ field: 'ServiceName', op: 'exists', value: '' });
    expect(clause).toBe('notEmpty(toString(ServiceName))');
  });

  it('not_exists → empty(toString(...))', () => {
    const clause = filterClause({ field: 'ServiceName', op: 'not_exists', value: '' });
    expect(clause).toBe('empty(toString(ServiceName))');
  });

  it('exists on Map accessor field', () => {
    const clause = filterClause({
      field: "LogAttributes['http.method']",
      op: 'exists',
      value: '',
    });
    expect(clause).toContain("notEmpty(toString(LogAttributes['http.method']))");
  });
});

// ── one_of / not_one_of ───────────────────────────────────────────────────────

describe('buildFilterClause — one_of / not_one_of', () => {
  it('one_of → IN clause with quoted values', () => {
    const clause = filterClause({
      field: 'ServiceName',
      op: 'one_of',
      value: '',
      values: ['api', 'worker'],
    });
    expect(clause).toContain('IN');
    expect(clause).toContain("'api'");
    expect(clause).toContain("'worker'");
  });

  it('not_one_of → NOT IN clause', () => {
    const clause = filterClause({
      field: 'ServiceName',
      op: 'not_one_of',
      value: '',
      values: ['debug', 'trace'],
    });
    expect(clause).toContain('NOT IN');
    expect(clause).toContain("'debug'");
    expect(clause).toContain("'trace'");
  });

  it('one_of with empty values → 1=0 (guard)', () => {
    const clause = filterClause({ field: 'ServiceName', op: 'one_of', value: '', values: [] });
    expect(clause).toBe('1=0');
  });

  it('not_one_of with empty values → 1=1 (guard)', () => {
    const clause = filterClause({ field: 'ServiceName', op: 'not_one_of', value: '', values: [] });
    expect(clause).toBe('1=1');
  });

  it('one_of falls back to single value string when values array absent', () => {
    const clause = filterClause({ field: 'ServiceName', op: 'one_of', value: 'api' });
    expect(clause).toContain('IN');
    expect(clause).toContain("'api'");
  });

  it('values with SQL-special chars are properly quoted', () => {
    const clause = filterClause({
      field: 'ServiceName',
      op: 'one_of',
      value: '',
      values: ["it's alive", 'back\\slash'],
    });
    expect(clause).toContain("'it\\'s alive'");
    expect(clause).toContain("'back\\\\slash'");
  });
});

// ── Existing ops still work ───────────────────────────────────────────────────

describe('buildFilterClause — existing ops unchanged', () => {
  it('= operator → exact equality', () => {
    const clause = filterClause({ field: 'ServiceName', op: '=', value: 'api' });
    expect(clause).toContain("= 'api'");
    expect(clause).not.toContain('ILIKE');
  });

  it('!= operator → not equal', () => {
    const clause = filterClause({ field: 'ServiceName', op: '!=', value: 'api' });
    expect(clause).toContain("!= 'api'");
  });

  it('contains → ILIKE with wildcards', () => {
    const clause = filterClause({ field: 'Body', op: 'contains', value: 'error' });
    expect(clause).toContain("ILIKE '%error%'");
  });

  it('not_contains → NOT ILIKE with wildcards', () => {
    const clause = filterClause({ field: 'Body', op: 'not_contains', value: 'debug' });
    expect(clause).toContain("NOT ILIKE '%debug%'");
  });
});

// ── filterLabel ───────────────────────────────────────────────────────────────

describe('filterLabel — new operators', () => {
  it('exists → "{field} exists"', () => {
    expect(filterLabel({ id: 'x', field: 'ServiceName', op: 'exists', value: '' })).toBe(
      'ServiceName exists'
    );
  });

  it('not_exists → "{field} does not exist"', () => {
    expect(filterLabel({ id: 'x', field: 'ServiceName', op: 'not_exists', value: '' })).toBe(
      'ServiceName does not exist'
    );
  });

  it('one_of → "{field} is one of [...]"', () => {
    const label = filterLabel({
      id: 'x',
      field: 'SeverityText',
      op: 'one_of',
      value: '',
      values: ['error', 'critical'],
    });
    expect(label).toBe('SeverityText is one of [error, critical]');
  });

  it('not_one_of → "{field} is not one of [...]"', () => {
    const label = filterLabel({
      id: 'x',
      field: 'SeverityText',
      op: 'not_one_of',
      value: '',
      values: ['debug'],
    });
    expect(label).toBe('SeverityText is not one of [debug]');
  });

  it('custom label overrides all logic', () => {
    expect(
      filterLabel({
        id: 'x',
        field: 'ServiceName',
        op: '=',
        value: 'api',
        label: 'My API service',
      })
    ).toBe('My API service');
  });
});

// ── addFilterPill ─────────────────────────────────────────────────────────────

describe('addFilterPill', () => {
  const existing: FilterPill = { id: 'a', field: 'ServiceName', op: '=', value: 'api' };

  it('appends a new pill', () => {
    const result = addFilterPill([existing], {
      id: 'b',
      field: 'Body',
      op: 'contains',
      value: 'error',
    });
    expect(result).toHaveLength(2);
  });

  it('dedupes an exact re-add (same field+op+value) instead of appending a duplicate', () => {
    const sameAgain: FilterPill = { id: 'c', field: 'ServiceName', op: '=', value: 'api' };
    const result = addFilterPill([existing], sameAgain);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('c');
  });

  it('appends (does not replace) a different value on the same field+op', () => {
    // Regression: "Filter out" on field X value 'a', then 'b', used to silently replace the
    // first pill instead of both applying as an AND (x != 'a' AND x != 'b').
    const excludeA: FilterPill = { id: 'a', field: 'ServiceName', op: '!=', value: 'a' };
    const excludeB: FilterPill = { id: 'b', field: 'ServiceName', op: '!=', value: 'b' };
    const result = addFilterPill([excludeA], excludeB);
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.value)).toEqual(['a', 'b']);
  });

  it('a different value on the same field+op="=" also appends, not replaces', () => {
    // No special-casing '=' differently from '!='/'contains' — see samePill's doc comment.
    const replacement: FilterPill = { id: 'c', field: 'ServiceName', op: '=', value: 'worker' };
    const result = addFilterPill([existing], replacement);
    expect(result).toHaveLength(2);
  });

  it('dedupes one_of/not_one_of by field+op+values set, order-insensitively', () => {
    const original: FilterPill = {
      id: 'x',
      field: 'SeverityText',
      op: 'one_of',
      value: '',
      values: ['error', 'critical'],
    };
    const reordered: FilterPill = {
      id: 'y',
      field: 'SeverityText',
      op: 'one_of',
      value: '',
      values: ['critical', 'error'],
    };
    const result = addFilterPill([original], reordered);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('y');
  });

  it('a different values set on one_of appends, not replaces', () => {
    const original: FilterPill = {
      id: 'x',
      field: 'SeverityText',
      op: 'one_of',
      value: '',
      values: ['error'],
    };
    const different: FilterPill = {
      id: 'y',
      field: 'SeverityText',
      op: 'one_of',
      value: '',
      values: ['critical'],
    };
    const result = addFilterPill([original], different);
    expect(result).toHaveLength(2);
  });

  it('preserves values and label on the incoming pill', () => {
    const pill: FilterPill = {
      id: 'd',
      field: 'SeverityText',
      op: 'one_of',
      value: '',
      values: ['error', 'critical'],
      label: 'Severe logs',
    };
    const result = addFilterPill([], pill);
    expect(result[0].values).toEqual(['error', 'critical']);
    expect(result[0].label).toBe('Severe logs');
  });
});
