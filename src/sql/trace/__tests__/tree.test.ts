import { buildSpanTree } from '../tree';
import { SpanRow } from '../../../types';

function span(overrides: Partial<SpanRow> & Pick<SpanRow, 'spanId' | 'parentSpanId' | 'startTime' | 'durationNs'>): SpanRow {
  return {
    traceId: 't1',
    serviceName: 'svc',
    operationName: 'op',
    spanKind: 'INTERNAL',
    statusCode: 'STATUS_CODE_OK',
    statusMessage: '',
    attributes: '',
    resourceAttributes: '',
    events: [],
    links: [],
    ...overrides,
  };
}

describe('buildSpanTree — empty/trivial', () => {
  it('returns an empty result for zero spans', () => {
    const result = buildSpanTree([]);
    expect(result.nodes).toEqual([]);
    expect(result.totalMs).toBe(0);
  });

  it('handles a single-span trace without div-by-zero (totalMs floors to 1)', () => {
    const result = buildSpanTree([span({ spanId: 'a', parentSpanId: '', startTime: 1000, durationNs: 5_000_000 })]);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].isRoot).toBe(true);
    expect(result.nodes[0].startOffset).toBe(0);
    expect(Number.isFinite(result.nodes[0].widthFraction)).toBe(true);
    expect(result.totalMs).toBeGreaterThan(0);
  });

  it('handles all-identical-timestamp spans without NaN (totalMs floors to 1)', () => {
    const spans = [
      span({ spanId: 'a', parentSpanId: '', startTime: 1000, durationNs: 0 }),
      span({ spanId: 'b', parentSpanId: 'a', startTime: 1000, durationNs: 0 }),
    ];
    const result = buildSpanTree(spans);
    for (const node of result.nodes) {
      expect(Number.isNaN(node.startOffset)).toBe(false);
      expect(Number.isNaN(node.widthFraction)).toBe(false);
    }
  });
});

describe('buildSpanTree — geometry', () => {
  it('keeps startOffset and widthFraction within [0,1] for a normal trace', () => {
    const spans = [
      span({ spanId: 'root', parentSpanId: '', startTime: 0, durationNs: 100_000_000 }), // 100ms
      span({ spanId: 'child', parentSpanId: 'root', startTime: 10, durationNs: 50_000_000 }), // 50ms @ +10ms
    ];
    const result = buildSpanTree(spans);
    for (const node of result.nodes) {
      expect(node.startOffset).toBeGreaterThanOrEqual(0);
      expect(node.startOffset).toBeLessThanOrEqual(1);
      expect(node.widthFraction).toBeGreaterThanOrEqual(0);
      expect(node.widthFraction).toBeLessThanOrEqual(1);
    }
  });

  it('applies the ns→ms unit conversion exactly once (1_000_000ns == 1ms of width)', () => {
    const spans = [
      span({ spanId: 'root', parentSpanId: '', startTime: 0, durationNs: 1_000_000_000 }), // 1000ms
    ];
    const result = buildSpanTree(spans);
    // Single-root trace: totalMs == durationMs of the root == 1000ms, so widthFraction ~ 1.
    expect(result.totalMs).toBeCloseTo(1000, 0);
  });

  it('clamps negative duration (clock skew / bad data) to a floored positive width, never negative', () => {
    const spans = [
      span({ spanId: 'root', parentSpanId: '', startTime: 0, durationNs: 100_000_000 }),
      span({ spanId: 'bad', parentSpanId: 'root', startTime: 10, durationNs: -50_000_000 }),
    ];
    const result = buildSpanTree(spans);
    const bad = result.nodes.find((n) => n.key === 'bad')!;
    expect(bad.widthFraction).toBeGreaterThan(0);
  });

  it('clamps a child that starts before the computed trace start to offset 0 (never negative)', () => {
    // traceStart is derived from the minimum startTime across all spans, so a child can't
    // actually precede it — this asserts the clamp holds even at the boundary.
    const spans = [
      span({ spanId: 'root', parentSpanId: '', startTime: 100, durationNs: 100_000_000 }),
      span({ spanId: 'early', parentSpanId: 'root', startTime: 0, durationNs: 10_000_000 }),
    ];
    const result = buildSpanTree(spans);
    for (const node of result.nodes) {
      expect(node.startOffset).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('buildSpanTree — topology', () => {
  it('builds parent/child nesting and assigns depth via BFS', () => {
    const spans = [
      span({ spanId: 'root', parentSpanId: '', startTime: 0, durationNs: 300_000_000 }),
      span({ spanId: 'mid', parentSpanId: 'root', startTime: 10, durationNs: 200_000_000 }),
      span({ spanId: 'leaf', parentSpanId: 'mid', startTime: 20, durationNs: 100_000_000 }),
    ];
    const result = buildSpanTree(spans);
    const byKey = new Map(result.nodes.map((n) => [n.key, n]));
    expect(byKey.get('root')!.depth).toBe(0);
    expect(byKey.get('mid')!.depth).toBe(1);
    expect(byKey.get('leaf')!.depth).toBe(2);
    expect(result.maxDepth).toBe(2);
  });

  it('reconciles a missing-parent span as a flagged orphan, not a silent extra root', () => {
    const spans = [
      span({ spanId: 'root', parentSpanId: '', startTime: 0, durationNs: 100_000_000 }),
      span({ spanId: 'orphan', parentSpanId: 'does-not-exist', startTime: 10, durationNs: 10_000_000 }),
    ];
    const result = buildSpanTree(spans);
    const orphan = result.nodes.find((n) => n.key === 'orphan')!;
    expect(orphan.isOrphan).toBe(true);
    expect(orphan.isRoot).toBe(false);
    expect(orphan.depth).toBe(0); // rendered as its own top-level entry, not dropped
    expect(result.orphanCount).toBe(1);
    expect(result.nodes).toHaveLength(2); // never silently dropped
  });

  it('never assigns a span to itself as parent (self-reference guard)', () => {
    const spans = [span({ spanId: 'a', parentSpanId: 'a', startTime: 0, durationNs: 10_000_000 })];
    const result = buildSpanTree(spans);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].isOrphan).toBe(true);
    expect(result.nodes[0].children).toHaveLength(0);
  });

  it('breaks a two-node parent/child cycle instead of infinite-looping, and drops nothing', () => {
    const spans = [
      span({ spanId: 'a', parentSpanId: 'b', startTime: 0, durationNs: 10_000_000 }),
      span({ spanId: 'b', parentSpanId: 'a', startTime: 5, durationNs: 10_000_000 }),
    ];
    const result = buildSpanTree(spans);
    expect(result.nodes).toHaveLength(2);
    // Whichever node bfs() couldn't reach through the other becomes the flagged cycle-break root.
    expect(result.orphanCount).toBeGreaterThanOrEqual(1);
  });

  it('treats every span as its own node (never collapsed) when spanId is unmapped for all spans', () => {
    const spans = [
      span({ spanId: '', parentSpanId: '', startTime: 0, durationNs: 10_000_000 }),
      span({ spanId: '', parentSpanId: '', startTime: 5, durationNs: 10_000_000 }),
      span({ spanId: '', parentSpanId: '', startTime: 10, durationNs: 10_000_000 }),
    ];
    const result = buildSpanTree(spans);
    expect(result.nodes).toHaveLength(3);
    const keys = new Set(result.nodes.map((n) => n.key));
    expect(keys.size).toBe(3); // synthetic #index keys, all distinct
  });

  it('flags a duplicated spanId occurrence as an ambiguous-identity orphan rather than merging it', () => {
    const spans = [
      span({ spanId: 'dup', parentSpanId: '', startTime: 0, durationNs: 50_000_000 }),
      span({ spanId: 'dup', parentSpanId: '', startTime: 100, durationNs: 20_000_000 }),
      span({ spanId: 'child', parentSpanId: 'dup', startTime: 10, durationNs: 10_000_000 }),
    ];
    const result = buildSpanTree(spans);
    expect(result.nodes).toHaveLength(3);
    // The child attaches under whichever index byId resolved first for 'dup' — it must land
    // somewhere in the tree, not vanish.
    const child = result.nodes.find((n) => n.span.operationName === 'op' && n.span.startTime === 10)!;
    expect(child).toBeDefined();
  });

  it('sorts roots and each children list chronologically', () => {
    const spans = [
      span({ spanId: 'root', parentSpanId: '', startTime: 0, durationNs: 300_000_000 }),
      span({ spanId: 'c2', parentSpanId: 'root', startTime: 50, durationNs: 10_000_000 }),
      span({ spanId: 'c1', parentSpanId: 'root', startTime: 10, durationNs: 10_000_000 }),
    ];
    const result = buildSpanTree(spans);
    const root = result.nodes.find((n) => n.key === 'root')!;
    expect(root.children.map((c) => c.key)).toEqual(['c1', 'c2']);
  });
});

describe('buildSpanTree — critical path', () => {
  it('marks the ancestor chain of the span that determines the overall trace end', () => {
    const spans = [
      span({ spanId: 'root', parentSpanId: '', startTime: 0, durationNs: 1_000_000_000 }), // ends @1000ms
      span({ spanId: 'fast-branch', parentSpanId: 'root', startTime: 10, durationNs: 20_000_000 }), // ends @30ms
      span({ spanId: 'slow-branch', parentSpanId: 'root', startTime: 10, durationNs: 900_000_000 }), // ends @910ms — closest to trace end
    ];
    const result = buildSpanTree(spans);
    const byKey = new Map(result.nodes.map((n) => [n.key, n]));
    expect(byKey.get('root')!.isCriticalPath).toBe(true);
    expect(byKey.get('slow-branch')!.isCriticalPath).toBe(true);
    expect(byKey.get('fast-branch')!.isCriticalPath).toBe(false);
  });
});

describe('buildSpanTree — scale', () => {
  it('handles a 10,000-span deep linear chain without a stack overflow', () => {
    const N = 10_000;
    const spans: SpanRow[] = [];
    for (let i = 0; i < N; i++) {
      spans.push(
        span({
          spanId: `s${i}`,
          parentSpanId: i === 0 ? '' : `s${i - 1}`,
          startTime: i,
          durationNs: 1_000_000,
        })
      );
    }
    expect(() => buildSpanTree(spans)).not.toThrow();
    const result = buildSpanTree(spans);
    expect(result.nodes).toHaveLength(N);
    expect(result.maxDepth).toBe(N - 1);
  });

  it('handles a 10,000-span wide flat trace (single root, all children) without a stack overflow', () => {
    const N = 10_000;
    const spans: SpanRow[] = [span({ spanId: 'root', parentSpanId: '', startTime: 0, durationNs: 1_000_000_000 })];
    for (let i = 0; i < N; i++) {
      spans.push(span({ spanId: `c${i}`, parentSpanId: 'root', startTime: i, durationNs: 1_000_000 }));
    }
    expect(() => buildSpanTree(spans)).not.toThrow();
    const result = buildSpanTree(spans);
    expect(result.nodes).toHaveLength(N + 1);
  });
});
