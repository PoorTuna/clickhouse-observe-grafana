import { __resetForTests, startAction } from '../tracer';
import { flattenSpanTree, querySpans, treeEndMs, hasRunningSpan } from '../spanTree';

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

describe('treeEndMs', () => {
  it('returns the root end when it has no children', () => {
    const action = startAction('a');
    action.end('ok');
    expect(treeEndMs(action.span)).toBe(action.span.endMs);
  });

  // Regression (B4): LogsExplorer.tsx's executeQuery ends the action once logs+volume settle, but
  // its `render` child closes later on the next rAF after commit — the action's own endMs is
  // earlier than a child it caused. A duration/scale computed from root.endMs alone under-reports
  // and clips that child's bar; treeEndMs must look at the whole tree.
  it('returns a later child end even when it ends after the root itself', () => {
    const action = startAction('a');
    const render = action.child('render', 'render');
    action.end('ok');
    render.end('ok');
    expect(render.span.endMs).not.toBeNull();
    expect(treeEndMs(action.span)).toBe(render.span.endMs);
    expect((render.span.endMs as number) >= (action.span.endMs as number)).toBe(true);
  });

  it('returns null while any span in the tree is still running', () => {
    const action = startAction('a');
    action.child('logs', 'logs');
    action.end('ok');
    expect(treeEndMs(action.span)).toBeNull();
  });
});

describe('hasRunningSpan', () => {
  it('is true while the root itself is running', () => {
    const action = startAction('a');
    expect(hasRunningSpan(action.span)).toBe(true);
  });

  it('is true when a child is still running under an already-ended root', () => {
    const action = startAction('a');
    const render = action.child('render', 'render');
    action.end('ok');
    expect(hasRunningSpan(action.span)).toBe(true);
    render.end('ok');
    expect(hasRunningSpan(action.span)).toBe(false);
  });

  it('is false once every span in the tree has ended', () => {
    const action = startAction('a');
    const logs = action.child('logs', 'logs');
    logs.end('ok');
    action.end('ok');
    expect(hasRunningSpan(action.span)).toBe(false);
  });
});
