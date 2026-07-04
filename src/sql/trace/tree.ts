/**
 * Pure span-tree builder for the trace waterfall. No React, no DOM — only geometry and topology,
 * so it can be unit-tested directly and reused by both the waterfall renderer and the service map.
 *
 * Unit invariant (see SpanRow in types.ts): `startTime` is always epoch-milliseconds, `durationNs`
 * is always nanoseconds. This module is the ONLY place that converts between them — never mix
 * units anywhere else.
 */
import { SpanRow } from '../../types';

export interface WaterfallNode {
  span: SpanRow;
  /** Unique render key — the spanId when it's non-empty and unique, else a synthetic `#<index>`. */
  key: string;
  children: WaterfallNode[];
  depth: number;
  /** 0–1, clamped, relative to traceStartMs. */
  startOffset: number;
  /** 0–1, clamped, floored to a minimum visible width. */
  widthFraction: number;
  /** True when parentSpanId === '' (a genuine root span). */
  isRoot: boolean;
  /**
   * True when this span could not be placed under its declared parent: the parent is missing
   * from the trace (partial load / sampling), the spanId was empty/duplicated (ambiguous
   * identity), or it was part of a parent/child cycle that had to be broken. Orphans are always
   * rendered — never silently dropped — but the UI should flag them distinctly from real roots.
   */
  isOrphan: boolean;
  isCriticalPath: boolean;
}

export interface TraceTreeResult {
  /** Flattened pre-order (DFS) render list — roots first, each followed by its subtree. */
  nodes: WaterfallNode[];
  traceStartMs: number;
  traceEndMs: number;
  totalMs: number;
  rootCount: number;
  orphanCount: number;
  maxDepth: number;
}

export interface BuildSpanTreeOpts {
  /** Minimum rendered span width, in ms, before it's floored to keep near-zero spans clickable. */
  minVisibleMs?: number;
}

const EMPTY_RESULT: TraceTreeResult = {
  nodes: [],
  traceStartMs: 0,
  traceEndMs: 0,
  totalMs: 0,
  rootCount: 0,
  orphanCount: 0,
  maxDepth: 0,
};

function clamp01(x: number): number {
  if (Number.isNaN(x)) {
    return 0;
  }
  return Math.min(Math.max(x, 0), 1);
}

export function buildSpanTree(spans: SpanRow[], opts: BuildSpanTreeOpts = {}): TraceTreeResult {
  const n = spans.length;
  if (n === 0) {
    return EMPTY_RESULT;
  }
  const minVisibleMs = opts.minVisibleMs ?? 0.5;

  // ── Bounds: plain loops, not Math.min/max(...spread) — a spread call over a large spans array
  // (10k+) risks "Maximum call stack size exceeded". Negative/zero durations are clamped to 0 here
  // so a single bad span (clock skew, bogus data) can't shrink the trace's own end time.
  let traceStartMs = spans[0].startTime;
  let traceEndMs = spans[0].startTime;
  const durationMsClamped = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const s = spans[i];
    const durMs = Math.max(s.durationNs / 1e6, 0);
    durationMsClamped[i] = durMs;
    if (s.startTime < traceStartMs) {
      traceStartMs = s.startTime;
    }
    const end = s.startTime + durMs;
    if (end > traceEndMs) {
      traceEndMs = end;
    }
  }
  const totalMs = Math.max(traceEndMs - traceStartMs, 1);

  // ── Identity: map spanId -> first index with that id. Spans with an empty spanId, or any
  // occurrence after the first of a duplicated spanId, can never be safely used as a parent
  // target (their identity is ambiguous) — they're excluded from the lookup entirely rather than
  // letting a later duplicate silently overwrite an earlier one (the original "everything
  // collapses to one node" bug when spanId is unmapped/empty for every span).
  const byId = new Map<string, number>();
  const ambiguousIdentity = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const id = spans[i].spanId;
    if (!id) {
      ambiguousIdentity[i] = true;
      continue;
    }
    if (byId.has(id)) {
      ambiguousIdentity[i] = true;
      continue;
    }
    byId.set(id, i);
  }

  // ── Topology: resolve each span's parent index (or none). A span becomes a root when it has no
  // usable parent — either genuinely (parentSpanId === '') or because its parent is unresolvable
  // (missing, self-reference, or this span's own identity is ambiguous).
  const parentIdx = new Array<number>(n).fill(-1);
  const childIdx: number[][] = Array.from({ length: n }, () => []);
  const isRoot = new Array<boolean>(n).fill(false);
  const isOrphan = new Array<boolean>(n).fill(false);
  const initialRoots: number[] = [];

  for (let i = 0; i < n; i++) {
    const span = spans[i];
    if (ambiguousIdentity[i]) {
      isRoot[i] = span.parentSpanId === '';
      isOrphan[i] = !isRoot[i];
      initialRoots.push(i);
      continue;
    }
    if (span.parentSpanId === '') {
      isRoot[i] = true;
      initialRoots.push(i);
      continue;
    }
    const pIdx = byId.get(span.parentSpanId);
    if (pIdx === undefined || pIdx === i) {
      isOrphan[i] = true;
      initialRoots.push(i);
      continue;
    }
    parentIdx[i] = pIdx;
    childIdx[pIdx].push(i);
  }

  // ── Depth assignment via iterative BFS (never recursion — depth-safe at scale). A global
  // visited set doubles as the cycle guard: if a node is reached a second time (only possible via
  // a parent/child cycle, since the topology pass above gives each node at most one parent), it is
  // skipped rather than re-queued, which breaks the cycle instead of looping forever.
  const depth = new Array<number>(n).fill(-1);
  const visited = new Array<boolean>(n).fill(false);
  let maxDepth = 0;

  const bfs = (startIndices: number[]) => {
    const queue: number[] = [];
    for (const idx of startIndices) {
      if (!visited[idx]) {
        visited[idx] = true;
        depth[idx] = 0;
        queue.push(idx);
      }
    }
    let head = 0;
    while (head < queue.length) {
      const idx = queue[head++];
      const d = depth[idx];
      if (d > maxDepth) {
        maxDepth = d;
      }
      for (const childI of childIdx[idx]) {
        if (!visited[childI]) {
          visited[childI] = true;
          depth[childI] = d + 1;
          queue.push(childI);
        }
      }
    }
  };

  bfs(initialRoots);

  // Anything left unvisited belongs to a parent/child cycle with no root of its own (e.g. two
  // spans that reference each other as parent) — the topology pass never pushed them to
  // initialRoots because each had a resolvable parent. Promote every remaining node to a root so
  // nothing is silently dropped from the render; the visited-set guard in bfs() still prevents the
  // cycle itself from looping.
  const cycleRoots: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!visited[i]) {
      isOrphan[i] = true;
      cycleRoots.push(i);
    }
  }
  if (cycleRoots.length > 0) {
    bfs(cycleRoots);
  }
  const roots = [...initialRoots, ...cycleRoots];

  // ── Stable ordering: chronological, tie-broken by spanId, applied to every children list and
  // to the root list itself so the waterfall reads top-to-bottom in time order.
  const byStart = (a: number, b: number) =>
    spans[a].startTime - spans[b].startTime || spans[a].spanId.localeCompare(spans[b].spanId);
  roots.sort(byStart);
  for (const children of childIdx) {
    children.sort(byStart);
  }

  // ── Critical path: descend from the "best" root, at each step following whichever child's own
  // end time (start+duration) is latest — the sub-span most responsible for extending that
  // branch's total latency — until a leaf. This is the direction that matters: a parent span
  // almost always encloses (and often outlasts) its children, so walking *up* from whichever span
  // has the single latest end time would just mark the root and stop there. A visited set guards
  // the descent itself in case a cycle-broken node still has a stale childIdx entry.
  const isCriticalPath = new Array<boolean>(n).fill(false);
  if (roots.length > 0) {
    let startRoot = roots[0];
    let bestRootEnd = -Infinity;
    for (const r of roots) {
      const end = spans[r].startTime + durationMsClamped[r];
      if (end > bestRootEnd) {
        bestRootEnd = end;
        startRoot = r;
      }
    }
    const walked = new Set<number>();
    let cur = startRoot;
    while (cur !== -1 && !walked.has(cur)) {
      isCriticalPath[cur] = true;
      walked.add(cur);
      const children = childIdx[cur];
      if (children.length === 0) {
        break;
      }
      let nextChild = children[0];
      let bestChildEnd = -Infinity;
      for (const childI of children) {
        const end = spans[childI].startTime + durationMsClamped[childI];
        if (end > bestChildEnd) {
          bestChildEnd = end;
          nextChild = childI;
        }
      }
      cur = nextChild;
    }
  }

  // ── Flatten to pre-order render list via an explicit stack (never recursion — a 10k-span
  // linear parent chain would otherwise blow the call stack). `placed` guards against visiting an
  // index twice — the only way that can happen is a cycle-broken node that is both promoted to
  // its own root AND still reachable through a stale childIdx entry from the node it used to
  // "point at"; without this guard the two would re-push each other onto the stack forever.
  const nodes: WaterfallNode[] = new Array(n);
  const built = new Array<WaterfallNode | null>(n).fill(null);
  const placed = new Array<boolean>(n).fill(false);
  const buildNode = (i: number): WaterfallNode => {
    const span = spans[i];
    const node: WaterfallNode = {
      span,
      key: ambiguousIdentity[i] ? `#${i}` : span.spanId,
      children: [],
      depth: depth[i],
      startOffset: clamp01((span.startTime - traceStartMs) / totalMs),
      widthFraction: clamp01(Math.max(durationMsClamped[i], minVisibleMs) / totalMs),
      isRoot: isRoot[i],
      isOrphan: isOrphan[i],
      isCriticalPath: isCriticalPath[i],
    };
    built[i] = node;
    return node;
  };

  let writeIdx = 0;
  const stack: number[] = [...roots].reverse();
  for (const r of roots) {
    placed[r] = true;
  }
  while (stack.length > 0) {
    const i = stack.pop()!;
    const node = built[i] ?? buildNode(i);
    nodes[writeIdx++] = node;
    // childIdx[i] is already sorted chronologically; build node.children in that same forward
    // order, but push onto the (LIFO) stack in reverse so the flattened pre-order traversal still
    // visits siblings chronologically.
    const liveChildren: number[] = [];
    for (const childI of childIdx[i]) {
      if (placed[childI]) {
        continue;
      }
      placed[childI] = true;
      liveChildren.push(childI);
      node.children.push(built[childI] ?? buildNode(childI));
    }
    for (let k = liveChildren.length - 1; k >= 0; k--) {
      stack.push(liveChildren[k]);
    }
  }

  let orphanCount = 0;
  for (let i = 0; i < n; i++) {
    if (isOrphan[i]) {
      orphanCount++;
    }
  }

  return {
    nodes,
    traceStartMs,
    traceEndMs,
    totalMs,
    rootCount: roots.length - cycleRoots.length,
    orphanCount,
    maxDepth,
  };
}
