/**
 * Unit tests for buildFilterClause (via buildWhereConditions) covering the
 * extended FilterOp set: exists, not_exists, one_of, not_one_of.
 * Also tests filterLabel output for the new operators and custom-label override.
 */

import { buildWhereConditions } from '../queryBuilder';
import { buildFieldIndex } from '../fields';
import { FieldModel } from '../fieldModel';
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
    // Quoted via quoteIdentifier() now — see C1 in the audit plan: this branch used to interpolate
    // the field expression completely unquoted, a direct SQL-injection route independent of
    // quoteIdentifier's own fix. Quoting a legitimate column name is semantically identical
    // ("ServiceName" and ServiceName refer to the same column) and closes that gap.
    expect(clause).toBe('notEmpty(toString("ServiceName"))');
  });

  it('not_exists → empty(toString(...))', () => {
    const clause = filterClause({ field: 'ServiceName', op: 'not_exists', value: '' });
    expect(clause).toBe('empty(toString("ServiceName"))');
  });

  it('exists on a hostile field name is quoted as one identifier, not spliced in raw', () => {
    const clause = filterClause({ field: 'x) OR 1=1 -- (', op: 'exists', value: '' });
    expect(clause).toBe('notEmpty(toString("x) OR 1=1 -- ("))');
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

// ── C1: hostile field names must never be interpolated unquoted ───────────────

describe('buildFilterClause — hostile field name (SQL injection regression guard)', () => {
  const hostile = 'x) OR 1=1 -- (';

  it('= operator quotes the whole hostile field as one identifier', () => {
    const clause = filterClause({ field: hostile, op: '=', value: 'api' });
    expect(clause).toBe(`"${hostile}" = 'api'`);
  });

  it('contains operator quotes the whole hostile field as one identifier', () => {
    const clause = filterClause({ field: hostile, op: 'contains', value: 'api' });
    expect(clause).toBe(`"${hostile}" ILIKE '%api%'`);
  });

  it('one_of operator quotes the whole hostile field as one identifier', () => {
    const clause = filterClause({ field: hostile, op: 'one_of', value: '', values: ['a', 'b'] });
    expect(clause).toBe(`"${hostile}" IN ('a', 'b')`);
  });

  it('a legitimate discovered Map accessor still passes through unquoted', () => {
    const clause = filterClause({ field: "LogAttributes['http.method']", op: '=', value: 'GET' });
    expect(clause).toBe("LogAttributes['http.method'] = 'GET'");
  });
});

// ── disabled pills ──────────────────────────────────────────────────────────

describe('buildWhereConditions — disabled pills', () => {
  it('a disabled filter emits no WHERE condition', () => {
    const conditions = buildWhereConditions(
      config,
      stateWithFilter({ field: 'ServiceName', op: '=', value: 'api', disabled: true })
    );
    // Only the timestamp range condition remains — the disabled filter is skipped entirely.
    expect(conditions).toHaveLength(1);
  });

  it('mixing an enabled and a disabled filter only emits the enabled one', () => {
    const state = {
      ...DEFAULT_LOGS_QUERY_STATE,
      filters: [
        { id: 'a', field: 'ServiceName', op: '=' as const, value: 'api' },
        { id: 'b', field: 'Body', op: 'contains' as const, value: 'error', disabled: true },
      ],
    };
    const conditions = buildWhereConditions(config, state);
    expect(conditions).toHaveLength(2);
    expect(conditions[1]).toContain("= 'api'");
  });
});

// ── fieldIndex threading ─────────────────────────────────────────────────────
//
// Regression test for a real bug: FieldStatsPopover.tsx built its WHERE conditions without
// passing the discovered FieldIndex through to buildWhereConditions, unlike every other call site
// (LogsExplorer's logsLoadValues, hydratePage, etc.) — so a filter on a discovered Map/JSON field
// silently resolved differently there than everywhere else on the page. This locks in that passing
// the index is what makes a discovered-but-not-directly-mapped field resolve correctly at all.

describe('buildWhereConditions — fieldIndex threading', () => {
  const jsonField: FieldModel = {
    id: 'json:Payload:user.id',
    name: 'user.id',
    displayName: 'user.id',
    sqlExpr: 'Payload.user.id',
    type: 'number',
    source: 'json',
    jsonColumn: 'Payload',
    jsonPath: 'user.id',
  };
  const index = buildFieldIndex([jsonField]);

  it('without an index, a filter on a discovered JSON field name falls back to a raw column reference', () => {
    const conditions = buildWhereConditions(
      config,
      stateWithFilter({ field: 'user.id', op: '=', value: '42' })
    );
    // resolveField(..., undefined) can't see the JSON field, so the field name is used verbatim —
    // wrong: "user.id" isn't a real column, ClickHouse would reject this. (quoteIdentifier skips
    // quoting names containing '.', treating them as already-qualified — see queryBuilder.ts.)
    expect(conditions[1]).toBe(`user.id = '42'`);
  });

  it('with the index, the same filter resolves to the real JSON path expression', () => {
    const conditions = buildWhereConditions(
      config,
      stateWithFilter({ field: 'user.id', op: '=', value: '42' }),
      index
    );
    expect(conditions[1]).toBe(`Payload.user.id = '42'`);
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
