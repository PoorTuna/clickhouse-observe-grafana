/**
 * Unit tests for the diagnostics tracer (src/diag/tracer.ts) — span nesting, the ring buffer's
 * eviction, idempotent end(), and the version counter subscribers rely on.
 */
import { __resetForTests, getRoots, getVersion, onRootEnd, startAction, startOrphanRoot, subscribe } from '../tracer';

beforeEach(() => {
  __resetForTests();
});

describe('startAction / child nesting', () => {
  it('creates a root span with the given name and kind "action"', () => {
    const handle = startAction('Search submit');
    expect(handle.span.name).toBe('Search submit');
    expect(handle.span.kind).toBe('action');
    expect(handle.span.parentId).toBeNull();
    expect(handle.span.rootId).toBe(handle.span.id);
    expect(handle.span.status).toBe('running');
  });

  it('nests a child under its parent, sharing the parent root id', () => {
    const action = startAction('Search submit');
    const query = action.child('logs', 'logs');
    expect(query.span.parentId).toBe(action.span.id);
    expect(query.span.rootId).toBe(action.span.id);
    expect(action.span.children).toContain(query.span);
  });

  it('supports arbitrarily deep nesting (query -> clickhouse -> ...) sharing the same root', () => {
    const action = startAction('Search submit');
    const query = action.child('logs', 'logs');
    const clickhouse = query.child('clickhouse exec', 'clickhouse');
    expect(clickhouse.span.rootId).toBe(action.span.id);
    expect(clickhouse.span.parentId).toBe(query.span.id);
  });

  it('registers a root in getRoots() immediately on creation, before it ends', () => {
    startAction('Search submit');
    expect(getRoots()).toHaveLength(1);
    expect(getRoots()[0].status).toBe('running');
  });

  // Regression: `name` is typed `string`, but a real build called startAction with a click
  // SyntheticEvent instead — a UI widget invoked a `() => void`-typed callback and passed its
  // event through anyway, which TypeScript can't catch. `span.name` renders directly as React
  // children in the rail/waterfall, so a non-string here isn't just a data-quality issue, it's a
  // crash (React error #31, "objects are not valid as a react child"). makeSpan coerces at the one
  // place every span is created rather than trusting every call site to always pass a real string.
  it('coerces a non-string name (e.g. an event object slipping through) to a safe string', () => {
    const fakeEvent = { _reactName: 'onClick', nativeEvent: {}, type: 'click' };
    const handle = startAction(fakeEvent as unknown as string);
    expect(typeof handle.span.name).toBe('string');
    expect(handle.span.name).not.toBe(fakeEvent);
  });

  it('coerces an empty string name to the span kind, so the rail is never blank', () => {
    const handle = startAction('');
    expect(handle.span.name).toBe('action');
  });
});

describe('startOrphanRoot — background work with no gesture behind it', () => {
  it('opens its own root named after the op, never anonymous', () => {
    const handle = startOrphanRoot('mapKeys');
    expect(handle.span.parentId).toBeNull();
    expect(handle.span.name).toBe('mapKeys');
    expect(handle.span.kind).toBe('mapKeys');
  });
});

describe('end()', () => {
  it('sets endMs and the given status, defaulting to "ok"', () => {
    const handle = startAction('a');
    handle.end();
    expect(handle.span.status).toBe('ok');
    expect(handle.span.endMs).not.toBeNull();
  });

  it('accepts error/cancelled status and merges attrs', () => {
    const handle = startAction('a');
    handle.end('cancelled', { reason: 'superseded' });
    expect(handle.span.status).toBe('cancelled');
    expect(handle.span.attrs.reason).toBe('superseded');
  });

  it('is idempotent — a second end() call does not overwrite the first result', () => {
    const handle = startAction('a');
    handle.end('error', { first: true });
    const endMsAfterFirst = handle.span.endMs;
    handle.end('ok', { second: true });
    expect(handle.span.status).toBe('error');
    expect(handle.span.endMs).toBe(endMsAfterFirst);
    expect(handle.span.attrs.second).toBeUndefined();
  });
});

describe('setAttrs / setError', () => {
  it('merges attrs without clobbering previously set ones', () => {
    const handle = startAction('a');
    handle.setAttrs({ x: 1 });
    handle.setAttrs({ y: 2 });
    expect(handle.span.attrs).toMatchObject({ x: 1, y: 2 });
  });

  it('records an error message on the span without ending it', () => {
    const handle = startAction('a');
    handle.setError('boom');
    expect(handle.span.error).toBe('boom');
    expect(handle.span.status).toBe('running');
  });
});

describe('ring buffer eviction', () => {
  it('keeps at most 20 roots, evicting the oldest first (FIFO)', () => {
    for (let i = 0; i < 25; i++) {
      startAction(`action-${i}`);
    }
    const roots = getRoots();
    expect(roots).toHaveLength(20);
    expect(roots[0].name).toBe('action-5');
    expect(roots[roots.length - 1].name).toBe('action-24');
  });

  it('does not evict children — only roots are bounded', () => {
    const action = startAction('a');
    for (let i = 0; i < 30; i++) {
      action.child(`q${i}`, 'logs');
    }
    expect(action.span.children).toHaveLength(30);
  });
});

describe('version counter + subscribe', () => {
  it('bumps version on every mutation: create, child, end, setAttrs, setError', () => {
    const v0 = getVersion();
    const handle = startAction('a');
    const v1 = getVersion();
    expect(v1).toBeGreaterThan(v0);

    handle.child('q', 'logs');
    const v2 = getVersion();
    expect(v2).toBeGreaterThan(v1);

    handle.setAttrs({ x: 1 });
    const v3 = getVersion();
    expect(v3).toBeGreaterThan(v2);

    handle.end();
    const v4 = getVersion();
    expect(v4).toBeGreaterThan(v3);
  });

  it('notifies subscribers on mutation and lets them unsubscribe', () => {
    const calls: number[] = [];
    const unsubscribe = subscribe(() => calls.push(getVersion()));

    startAction('a');
    expect(calls).toHaveLength(1);

    unsubscribe();
    startAction('b');
    expect(calls).toHaveLength(1); // no further notifications after unsubscribing
  });
});

describe('onRootEnd', () => {
  it('fires when a root span ends', () => {
    const calls: string[] = [];
    onRootEnd((span) => calls.push(span.name));
    const action = startAction('Search submit');
    action.end('ok');
    expect(calls).toEqual(['Search submit']);
  });

  it('does not fire for a child span ending', () => {
    const calls: string[] = [];
    onRootEnd((span) => calls.push(span.name));
    const action = startAction('Search submit');
    const query = action.child('logs', 'logs');
    query.end('ok');
    expect(calls).toEqual([]);
  });

  it('fires for an orphan root too, not just an explicit action', () => {
    const calls: string[] = [];
    onRootEnd((span) => calls.push(span.name));
    startOrphanRoot('mapKeys').end('ok');
    expect(calls).toEqual(['mapKeys']);
  });

  it('unsubscribes cleanly', () => {
    const calls: string[] = [];
    const unsubscribe = onRootEnd((span) => calls.push(span.name));
    unsubscribe();
    startAction('a').end('ok');
    expect(calls).toEqual([]);
  });
});

describe('root wall-clock stamp', () => {
  it('stamps a root (but not a child) with attrs.startedAt for the activity rail\'s "when" display', () => {
    const action = startAction('a');
    expect(typeof action.span.attrs.startedAt).toBe('number');

    const child = action.child('q', 'logs');
    expect(child.span.attrs.startedAt).toBeUndefined();
  });
});
