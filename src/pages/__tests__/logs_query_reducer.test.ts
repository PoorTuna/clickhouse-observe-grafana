/**
 * Unit tests for logsQueryReducer — extracted from LogsExplorer.tsx into its own module so it's
 * testable independent of mounting the whole page. Covers every action, including the two
 * edge cases most likely to regress silently: REMOVE_COLUMN clearing a stale sort target, and
 * ADD_COLUMN's targetId insertion vs. plain append.
 */
import { logsQueryReducer } from '../_logsQueryReducer';
import { DEFAULT_LOGS_QUERY_STATE, LogsQueryState, SelectedColumn } from '../../types';

function col(id: string, key = `fld_${id}`): SelectedColumn {
  return { id, key, sqlExpr: id, displayName: id, type: 'string', isCore: false };
}

const base: LogsQueryState = { ...DEFAULT_LOGS_QUERY_STATE };

describe('logsQueryReducer — simple field updates', () => {
  it('SET_SEARCH replaces search', () => {
    expect(logsQueryReducer(base, { type: 'SET_SEARCH', value: 'level:error' }).search).toBe(
      'level:error'
    );
  });

  it('SET_FILTERS replaces filters', () => {
    const filters = [{ id: 'f1', field: 'ServiceName', op: '=' as const, value: 'api' }];
    expect(logsQueryReducer(base, { type: 'SET_FILTERS', filters }).filters).toBe(filters);
  });

  it('TOGGLE_RAW_SQL flips useRawSql', () => {
    expect(logsQueryReducer(base, { type: 'TOGGLE_RAW_SQL' }).useRawSql).toBe(true);
    expect(logsQueryReducer({ ...base, useRawSql: true }, { type: 'TOGGLE_RAW_SQL' }).useRawSql).toBe(false);
  });

  it('SET_RAW_SQL replaces rawSql', () => {
    expect(logsQueryReducer(base, { type: 'SET_RAW_SQL', sql: 'SELECT 1' }).rawSql).toBe('SELECT 1');
  });

  it('LOAD_SAVED merges a partial state patch', () => {
    const next = logsQueryReducer(base, { type: 'LOAD_SAVED', state: { search: 'x', useRawSql: false } });
    expect(next.search).toBe('x');
    expect(next.limit).toBe(base.limit); // untouched fields survive the merge
  });
});

describe('logsQueryReducer — ADD_COLUMN', () => {
  it('appends when no targetId is given', () => {
    const columns = [col('a')];
    const next = logsQueryReducer(base, { type: 'ADD_COLUMN', col: col('b'), columns });
    expect(next.columns.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('inserts before targetId when given', () => {
    const columns = [col('a'), col('c')];
    const next = logsQueryReducer(base, { type: 'ADD_COLUMN', col: col('b'), columns, targetId: 'c' });
    expect(next.columns.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op if the column id is already present', () => {
    const columns = [col('a'), col('b')];
    const next = logsQueryReducer(base, { type: 'ADD_COLUMN', col: col('b'), columns });
    expect(next).toBe(base); // state unchanged, not even a new columns array
  });
});

describe('logsQueryReducer — REMOVE_COLUMN', () => {
  it('removes the column by id', () => {
    const columns = [col('a'), col('b')];
    const next = logsQueryReducer(base, { type: 'REMOVE_COLUMN', id: 'a', columns });
    expect(next.columns.map((c) => c.id)).toEqual(['b']);
  });

  it('clears sort when the removed column was the active sort target', () => {
    const columns = [col('a'), col('b')];
    const stateWithSort: LogsQueryState = { ...base, sort: { col: 'fld_a', dir: 'asc' } };
    const next = logsQueryReducer(stateWithSort, { type: 'REMOVE_COLUMN', id: 'a', columns });
    expect(next.sort).toBeUndefined();
  });

  it('leaves sort untouched when a different column is removed', () => {
    const columns = [col('a'), col('b')];
    const stateWithSort: LogsQueryState = { ...base, sort: { col: 'fld_a', dir: 'asc' } };
    const next = logsQueryReducer(stateWithSort, { type: 'REMOVE_COLUMN', id: 'b', columns });
    expect(next.sort).toEqual({ col: 'fld_a', dir: 'asc' });
  });
});

describe('logsQueryReducer — REORDER_COLUMN', () => {
  it('swaps with the left neighbor', () => {
    const columns = [col('a'), col('b'), col('c')];
    const next = logsQueryReducer(base, { type: 'REORDER_COLUMN', id: 'b', direction: 'left', columns });
    expect(next.columns.map((c) => c.id)).toEqual(['b', 'a', 'c']);
  });

  it('swaps with the right neighbor', () => {
    const columns = [col('a'), col('b'), col('c')];
    const next = logsQueryReducer(base, { type: 'REORDER_COLUMN', id: 'b', direction: 'right', columns });
    expect(next.columns.map((c) => c.id)).toEqual(['a', 'c', 'b']);
  });

  it('is a no-op at either edge', () => {
    const columns = [col('a'), col('b')];
    const leftEdge = logsQueryReducer(base, { type: 'REORDER_COLUMN', id: 'a', direction: 'left', columns });
    const rightEdge = logsQueryReducer(base, { type: 'REORDER_COLUMN', id: 'b', direction: 'right', columns });
    expect(leftEdge).toBe(base);
    expect(rightEdge).toBe(base);
  });
});

describe('logsQueryReducer — MOVE_COLUMN_TO', () => {
  it('moves the dragged column to the target position', () => {
    const columns = [col('a'), col('b'), col('c'), col('d')];
    const next = logsQueryReducer(base, { type: 'MOVE_COLUMN_TO', id: 'd', targetId: 'a', columns });
    expect(next.columns.map((c) => c.id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('is a no-op when id and targetId match', () => {
    const columns = [col('a'), col('b')];
    const next = logsQueryReducer(base, { type: 'MOVE_COLUMN_TO', id: 'a', targetId: 'a', columns });
    expect(next).toBe(base);
  });
});

describe('logsQueryReducer — SET_SORT', () => {
  it('sets a new sort column to desc first', () => {
    const next = logsQueryReducer(base, { type: 'SET_SORT', col: '__timestamp' });
    expect(next.sort).toEqual({ col: '__timestamp', dir: 'desc' });
  });

  it('toggles desc -> asc on the same column', () => {
    const withSort: LogsQueryState = { ...base, sort: { col: '__timestamp', dir: 'desc' } };
    const next = logsQueryReducer(withSort, { type: 'SET_SORT', col: '__timestamp' });
    expect(next.sort).toEqual({ col: '__timestamp', dir: 'asc' });
  });

  it('switching to a different column resets to desc', () => {
    const withSort: LogsQueryState = { ...base, sort: { col: '__timestamp', dir: 'asc' } };
    const next = logsQueryReducer(withSort, { type: 'SET_SORT', col: 'fld_a' });
    expect(next.sort).toEqual({ col: 'fld_a', dir: 'desc' });
  });
});
