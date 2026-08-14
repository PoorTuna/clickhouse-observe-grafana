import { __resetForTests, startAction } from '../tracer';
import { flattenSpanTree, querySpans } from '../spanTree';

beforeEach(() => {
  __resetForTests();
});

describe('flattenSpanTree', () => {
  it('flattens depth-first, preserving creation order, with correct depths', () => {
    const action = startAction('Search submit');
    const logs = action.child('logs', 'logs');
    logs.child('clickhouse exec', 'clickhouse');
    action.child('volume', 'volume');

    const rows = flattenSpanTree(action.span);
    expect(rows.map((r) => [r.span.name, r.depth])).toEqual([
      ['Search submit', 0],
      ['logs', 1],
      ['clickhouse exec', 2],
      ['volume', 1],
    ]);
  });

  it('handles a childless root', () => {
    const action = startAction('a');
    expect(flattenSpanTree(action.span)).toEqual([{ span: action.span, depth: 0 }]);
  });
});

describe('querySpans', () => {
  it('picks out only spans that carry attrs.sql (set by runQuery.ts on real queries)', () => {
    const action = startAction('Search submit');
    const logs = action.child('logs', 'logs');
    logs.setAttrs({ sql: 'SELECT 1' });
    action.child('build', 'build'); // structural span, no sql attr

    const spans = querySpans(action.span);
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('logs');
  });

  it('returns an empty array when no query spans exist yet', () => {
    const action = startAction('a');
    expect(querySpans(action.span)).toEqual([]);
  });
});
