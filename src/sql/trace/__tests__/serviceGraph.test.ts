import { buildServiceGraph } from '../serviceGraph';
import { SpanRow } from '../../../types';

function span(overrides: Partial<SpanRow> & Pick<SpanRow, 'spanId' | 'parentSpanId' | 'serviceName' | 'startTime' | 'durationNs'>): SpanRow {
  return {
    traceId: 't1',
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

describe('buildServiceGraph — empty', () => {
  it('returns empty nodes/edges for zero spans', () => {
    expect(buildServiceGraph([])).toEqual({ nodes: [], edges: [] });
  });
});

describe('buildServiceGraph — nodes', () => {
  it('one node per distinct service with call/error counts and latency stats', () => {
    const spans = [
      span({ spanId: 'a', parentSpanId: '', serviceName: 'gateway', startTime: 0, durationNs: 100_000_000 }),
      span({ spanId: 'b', parentSpanId: 'a', serviceName: 'orders', startTime: 10, durationNs: 50_000_000 }),
      span({
        spanId: 'c',
        parentSpanId: 'a',
        serviceName: 'orders',
        startTime: 60,
        durationNs: 20_000_000,
        statusCode: 'STATUS_CODE_ERROR',
      }),
    ];
    const { nodes } = buildServiceGraph(spans);
    const gateway = nodes.find((n) => n.id === 'gateway')!;
    const orders = nodes.find((n) => n.id === 'orders')!;
    expect(gateway.callCount).toBe(1);
    expect(orders.callCount).toBe(2);
    expect(orders.errorCount).toBe(1);
    expect(orders.errorRate).toBeCloseTo(0.5);
    expect(orders.avgDurationMs).toBeCloseTo(35, 0);
    expect(orders.maxDurationMs).toBeCloseTo(50, 0);
  });

  it('groups spans with an unmapped/empty serviceName under "unknown" rather than dropping them', () => {
    const spans = [span({ spanId: 'a', parentSpanId: '', serviceName: '', startTime: 0, durationNs: 10_000_000 })];
    const { nodes } = buildServiceGraph(spans);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe('unknown');
  });
});

describe('buildServiceGraph — edges', () => {
  it('creates one edge per distinct (caller service -> callee service) pair', () => {
    const spans = [
      span({ spanId: 'a', parentSpanId: '', serviceName: 'gateway', startTime: 0, durationNs: 100_000_000 }),
      span({ spanId: 'b', parentSpanId: 'a', serviceName: 'orders', startTime: 10, durationNs: 50_000_000 }),
      span({ spanId: 'c', parentSpanId: 'a', serviceName: 'orders', startTime: 60, durationNs: 10_000_000 }),
    ];
    const { edges } = buildServiceGraph(spans);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 'gateway', target: 'orders', callCount: 2 });
  });

  it('excludes same-service self-edges by default', () => {
    const spans = [
      span({ spanId: 'a', parentSpanId: '', serviceName: 'orders', startTime: 0, durationNs: 100_000_000 }),
      span({ spanId: 'b', parentSpanId: 'a', serviceName: 'orders', startTime: 10, durationNs: 10_000_000 }),
    ];
    const { edges } = buildServiceGraph(spans);
    expect(edges).toHaveLength(0);
  });

  it('includes self-edges when includeSelfEdges is set', () => {
    const spans = [
      span({ spanId: 'a', parentSpanId: '', serviceName: 'orders', startTime: 0, durationNs: 100_000_000 }),
      span({ spanId: 'b', parentSpanId: 'a', serviceName: 'orders', startTime: 10, durationNs: 10_000_000 }),
    ];
    const { edges } = buildServiceGraph(spans, { includeSelfEdges: true });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 'orders', target: 'orders' });
  });

  it('does not synthesize an edge when the parent span is missing (orphan)', () => {
    const spans = [
      span({ spanId: 'orphan-child', parentSpanId: 'does-not-exist', serviceName: 'orders', startTime: 0, durationNs: 10_000_000 }),
    ];
    const { edges } = buildServiceGraph(spans);
    expect(edges).toHaveLength(0);
  });

  it('resolves an edge through the first occurrence of a duplicated spanId (never drops it)', () => {
    // Real-world case: a demo-data generator reused identical span/trace IDs across repeated
    // requests. The *later* occurrence of 'dup' is itself ambiguous and excluded as an edge
    // endpoint, but a child pointing at 'dup' must still resolve through the first occurrence —
    // dropping that lookup entirely would silently erase every edge through a repeated id,
    // including ones from spans that aren't ambiguous themselves.
    const spans = [
      span({ spanId: 'dup', parentSpanId: '', serviceName: 'a', startTime: 0, durationNs: 10_000_000 }),
      span({ spanId: 'dup', parentSpanId: '', serviceName: 'b', startTime: 1, durationNs: 10_000_000 }),
      span({ spanId: 'child-of-dup', parentSpanId: 'dup', serviceName: 'orders', startTime: 5, durationNs: 5_000_000 }),
    ];
    const { edges } = buildServiceGraph(spans);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 'a', target: 'orders' });
  });

  it('aggregates error count and error rate per edge', () => {
    const spans = [
      span({ spanId: 'a', parentSpanId: '', serviceName: 'gateway', startTime: 0, durationNs: 100_000_000 }),
      span({
        spanId: 'b',
        parentSpanId: 'a',
        serviceName: 'orders',
        startTime: 10,
        durationNs: 10_000_000,
        statusCode: 'STATUS_CODE_ERROR',
      }),
      span({ spanId: 'c', parentSpanId: 'a', serviceName: 'orders', startTime: 20, durationNs: 10_000_000 }),
      span({ spanId: 'd', parentSpanId: 'a', serviceName: 'orders', startTime: 30, durationNs: 10_000_000 }),
      span({ spanId: 'e', parentSpanId: 'a', serviceName: 'orders', startTime: 40, durationNs: 10_000_000 }),
    ];
    const { edges } = buildServiceGraph(spans);
    const edge = edges.find((e) => e.source === 'gateway' && e.target === 'orders')!;
    expect(edge.callCount).toBe(4);
    expect(edge.errorCount).toBe(1);
    expect(edge.errorRate).toBeCloseTo(0.25);
  });
});
