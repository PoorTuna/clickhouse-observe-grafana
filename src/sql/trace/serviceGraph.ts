/**
 * Pure reducer: the spans of a single trace → a per-trace service graph (nodes = services,
 * edges = cross-service calls), shaped to translate directly into a Grafana NodeGraph DataFrame
 * pair (nodes frame: id/title/mainstat/secondarystat/arc__ok/arc__error; edges frame:
 * id/source/target/mainstat/secondarystat). Kept free of any Grafana/DataFrame types so it's
 * trivially unit-testable — the DataFrame conversion happens in the ServiceMap component.
 */
import { SpanRow } from '../../types';

const OTEL_STATUS_ERROR = 'STATUS_CODE_ERROR';
const UNKNOWN_SERVICE = 'unknown';

export interface ServiceGraphNode {
  id: string;
  title: string;
  callCount: number;
  errorCount: number;
  /** 0–1 */
  errorRate: number;
  avgDurationMs: number;
  maxDurationMs: number;
}

export interface ServiceGraphEdge {
  id: string;
  source: string;
  target: string;
  callCount: number;
  errorCount: number;
  /** 0–1 */
  errorRate: number;
  avgDurationMs: number;
}

export interface ServiceGraphResult {
  nodes: ServiceGraphNode[];
  edges: ServiceGraphEdge[];
}

export interface BuildServiceGraphOpts {
  /** Include same-service→same-service edges (recursive/internal calls). Default false. */
  includeSelfEdges?: boolean;
}

interface Accumulator {
  callCount: number;
  errorCount: number;
  /** Running sum, not a stored array — keeps memory O(services/edges) instead of O(spans). */
  durationMsSum: number;
  durationMsMax: number;
}

function newAccumulator(): Accumulator {
  return { callCount: 0, errorCount: 0, durationMsSum: 0, durationMsMax: 0 };
}

function addSpan(acc: Accumulator, span: SpanRow): void {
  acc.callCount++;
  if (span.statusCode === OTEL_STATUS_ERROR) {
    acc.errorCount++;
  }
  const durMs = Math.max(span.durationNs / 1e6, 0);
  acc.durationMsSum += durMs;
  if (durMs > acc.durationMsMax) {
    acc.durationMsMax = durMs;
  }
}

export function buildServiceGraph(spans: SpanRow[], opts: BuildServiceGraphOpts = {}): ServiceGraphResult {
  if (spans.length === 0) {
    return { nodes: [], edges: [] };
  }
  const includeSelfEdges = opts.includeSelfEdges ?? false;

  // spanId -> serviceName, first-occurrence-wins — matches tree.ts's ambiguousIdentity handling:
  // a later occurrence of a duplicated spanId is itself ambiguous (excluded as an edge's own
  // caller/callee below), but the first occurrence remains a perfectly valid lookup target for
  // other spans' parentSpanId. Deleting the first occurrence too (an earlier version of this
  // function did) would silently drop every edge through that id, including from spans that
  // aren't ambiguous themselves — verified against a real trace where a demo-data generator had
  // reused identical span/trace IDs across repeated requests.
  const idToService = new Map<string, string>();
  for (const span of spans) {
    if (!span.spanId || idToService.has(span.spanId)) {
      continue;
    }
    idToService.set(span.spanId, span.serviceName || UNKNOWN_SERVICE);
  }

  const nodeAcc = new Map<string, Accumulator>();
  for (const span of spans) {
    const service = span.serviceName || UNKNOWN_SERVICE;
    let acc = nodeAcc.get(service);
    if (!acc) {
      acc = newAccumulator();
      nodeAcc.set(service, acc);
    }
    addSpan(acc, span);
  }

  const edgeAcc = new Map<string, { source: string; target: string; acc: Accumulator }>();
  for (const span of spans) {
    if (!span.parentSpanId) {
      continue;
    }
    const source = idToService.get(span.parentSpanId);
    if (source === undefined) {
      continue; // parent missing/ambiguous — no known caller, no edge to synthesize
    }
    const target = span.serviceName || UNKNOWN_SERVICE;
    if (source === target && !includeSelfEdges) {
      continue;
    }
    const key = `${source}::${target}`;
    let entry = edgeAcc.get(key);
    if (!entry) {
      entry = { source, target, acc: newAccumulator() };
      edgeAcc.set(key, entry);
    }
    addSpan(entry.acc, span);
  }

  const nodes: ServiceGraphNode[] = [];
  for (const [service, acc] of nodeAcc) {
    nodes.push({
      id: service,
      title: service,
      callCount: acc.callCount,
      errorCount: acc.errorCount,
      errorRate: acc.errorCount / acc.callCount,
      avgDurationMs: acc.durationMsSum / acc.callCount,
      maxDurationMs: acc.durationMsMax,
    });
  }
  nodes.sort((a, b) => b.callCount - a.callCount || a.id.localeCompare(b.id));

  const edges: ServiceGraphEdge[] = [];
  for (const [key, { source, target, acc }] of edgeAcc) {
    edges.push({
      id: key,
      source,
      target,
      callCount: acc.callCount,
      errorCount: acc.errorCount,
      errorRate: acc.errorCount / acc.callCount,
      avgDurationMs: acc.durationMsSum / acc.callCount,
    });
  }
  edges.sort((a, b) => b.callCount - a.callCount || a.id.localeCompare(b.id));

  return { nodes, edges };
}
