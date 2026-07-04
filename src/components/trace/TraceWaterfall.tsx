import React, { useMemo, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, IconName } from '@grafana/data';
import { useStyles2, Icon, IconButton, Input, Button, Tooltip, Alert } from '@grafana/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import { SpanRow } from '../../types';
import { buildSpanTree, WaterfallNode } from '../../sql/trace/tree';
import { serviceColor } from '../../constants';
import { TraceMinimap } from './TraceMinimap';
import { formatNs } from '../../utils/traceFormat';

interface TraceWaterfallProps {
  spans: SpanRow[];
  selectedSpanKey?: string;
  onSelectSpan: (node: WaterfallNode) => void;
  /** True when the detail query hit its row LIMIT — some spans may be missing. */
  truncated?: boolean;
}

const ROW_HEIGHT = 26;
const LABEL_WIDTH = 340;
const INDENT = 14;

const SPAN_KIND_ICON: Record<string, IconName> = {
  SERVER: 'arrow-down',
  CLIENT: 'arrow-up',
  PRODUCER: 'arrow-to-right',
  CONSUMER: 'import',
  INTERNAL: 'cog',
};
const DEFAULT_KIND_ICON: IconName = 'arrow-random';

function clamp01(x: number): number {
  return Math.min(Math.max(x, 0), 1);
}

/**
 * For each node (by key), whether it or any span in its subtree matches `predicate`. Computed in a
 * single reverse pass over the pre-order flat list — every child of a node appears later in
 * pre-order than the node itself, so by the time we reach a node in reverse, all of its children's
 * flags are already known. O(total nodes), no recursion.
 */
function computeSubtreeMatch(flat: WaterfallNode[], predicate: (n: WaterfallNode) => boolean): Set<string> {
  const flag = new Map<string, boolean>();
  for (let i = flat.length - 1; i >= 0; i--) {
    const node = flat[i];
    let has = predicate(node);
    if (!has) {
      for (const c of node.children) {
        if (flag.get(c.key)) {
          has = true;
          break;
        }
      }
    }
    flag.set(node.key, has);
  }
  const result = new Set<string>();
  for (const [key, has] of flag) {
    if (has) {
      result.add(key);
    }
  }
  return result;
}

export function TraceWaterfall({ spans, selectedSpanKey, onSelectSpan, truncated }: TraceWaterfallProps) {
  const styles = useStyles2(getStyles);
  const parentRef = useRef<HTMLDivElement>(null);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [showMatchesOnly, setShowMatchesOnly] = useState(false);
  const [criticalPathOnly, setCriticalPathOnly] = useState(false);
  const [zoom, setZoom] = useState<{ start: number; end: number }>({ start: 0, end: 1 });
  const [matchCursor, setMatchCursor] = useState(0);

  const tree = useMemo(() => buildSpanTree(spans), [spans]);

  const searchTerm = search.trim().toLowerCase();
  const isMatch = (n: WaterfallNode) =>
    searchTerm.length > 0 &&
    (n.span.operationName.toLowerCase().includes(searchTerm) ||
      n.span.serviceName.toLowerCase().includes(searchTerm) ||
      n.span.spanId.toLowerCase().includes(searchTerm));

  const subtreeMatch = useMemo(
    () => (searchTerm ? computeSubtreeMatch(tree.nodes, isMatch) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree.nodes, searchTerm]
  );

  // Visible rows: when "matches only" or "critical path only" is active, ancestor context takes
  // priority over manual collapse — the point of those filters is to find spans regardless of
  // current expand state, so collapse is bypassed rather than combined with it.
  const visibleRows = useMemo(() => {
    const rows: WaterfallNode[] = [];
    const bypassCollapse = (showMatchesOnly && subtreeMatch !== null) || criticalPathOnly;
    let suppressDepth = Infinity;
    for (const node of tree.nodes) {
      if (!bypassCollapse) {
        if (node.depth <= suppressDepth) {
          suppressDepth = Infinity;
        }
        if (node.depth > suppressDepth) {
          continue;
        }
      }
      if (showMatchesOnly && subtreeMatch !== null && !subtreeMatch.has(node.key)) {
        continue;
      }
      if (criticalPathOnly && !node.isCriticalPath) {
        continue;
      }
      rows.push(node);
      if (!bypassCollapse && collapsed.has(node.key)) {
        suppressDepth = node.depth;
      }
    }
    return rows;
  }, [tree.nodes, collapsed, showMatchesOnly, criticalPathOnly, subtreeMatch]);

  const matchedKeysInView = useMemo(
    () => (searchTerm ? visibleRows.filter(isMatch).map((n) => n.key) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleRows, searchTerm]
  );

  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const expandAll = () => setCollapsed(new Set());
  const collapseAll = () => {
    const withChildren = tree.nodes.filter((n) => n.children.length > 0).map((n) => n.key);
    setCollapsed(new Set(withChildren));
  };

  const goToMatch = (dir: 1 | -1) => {
    if (matchedKeysInView.length === 0) {
      return;
    }
    const next = (matchCursor + dir + matchedKeysInView.length) % matchedKeysInView.length;
    setMatchCursor(next);
    const key = matchedKeysInView[next];
    const idx = visibleRows.findIndex((n) => n.key === key);
    if (idx >= 0) {
      virtualizer.scrollToIndex(idx, { align: 'center' });
    }
  };

  if (spans.length === 0) {
    return <div className={styles.empty}>No spans found.</div>;
  }

  const winLen = Math.max(zoom.end - zoom.start, 1e-9);

  return (
    <div className={styles.container}>
      {truncated && (
        <Alert severity="warning" title="Trace truncated" className={styles.truncatedAlert}>
          This trace has more spans than the query limit — some spans are not shown.
        </Alert>
      )}
      {tree.orphanCount > 0 && (
        <Alert severity="info" title="Partial trace" className={styles.truncatedAlert}>
          {tree.orphanCount} span{tree.orphanCount === 1 ? '' : 's'} reference a parent that is not in this trace
          (partial load, sampling, or malformed data) — shown as top-level entries.
        </Alert>
      )}

      {/* Toolbar */}
      <div className={styles.toolbar}>
        <Input
          className={styles.search}
          prefix={<Icon name="search" />}
          placeholder="Find spans by service, operation, or span ID…"
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value);
            setMatchCursor(0);
          }}
        />
        {searchTerm && (
          <div className={styles.matchNav}>
            <span className={styles.matchCount}>
              {matchedKeysInView.length > 0 ? `${matchCursor + 1} / ${matchedKeysInView.length}` : '0 / 0'}
            </span>
            <IconButton name="angle-up" tooltip="Previous match" onClick={() => goToMatch(-1)} />
            <IconButton name="angle-down" tooltip="Next match" onClick={() => goToMatch(1)} />
            <Button
              size="sm"
              variant={showMatchesOnly ? 'primary' : 'secondary'}
              fill="outline"
              onClick={() => setShowMatchesOnly((v) => !v)}
            >
              Matches only
            </Button>
          </div>
        )}
        <Button
          size="sm"
          variant={criticalPathOnly ? 'primary' : 'secondary'}
          fill="outline"
          icon="arrow-random"
          onClick={() => setCriticalPathOnly((v) => !v)}
        >
          Critical path
        </Button>
        <Button
          size="sm"
          variant="secondary"
          fill="text"
          icon="angle-double-down"
          tooltip="Expand all"
          onClick={expandAll}
        />
        <Button
          size="sm"
          variant="secondary"
          fill="text"
          icon="angle-double-up"
          tooltip="Collapse all"
          onClick={collapseAll}
        />
      </div>

      {/* Minimap */}
      <TraceMinimap
        nodes={tree.nodes}
        zoomStart={zoom.start}
        zoomEnd={zoom.end}
        onZoomChange={(start, end) => setZoom({ start, end })}
        onReset={() => setZoom({ start: 0, end: 1 })}
      />

      {/* Axis */}
      <div className={styles.headerRow}>
        <div className={styles.labelCol}>Span</div>
        <div className={styles.barCol}>
          <div className={styles.barAxis}>
            {[0, 0.25, 0.5, 0.75, 1].map((f) => {
              const ms = zoom.start * tree.totalMs + f * winLen * tree.totalMs;
              return <span key={f}>{formatNs(ms * 1e6)}</span>;
            })}
          </div>
        </div>
      </div>

      {/* Virtualized rows */}
      <div ref={parentRef} className={styles.scrollArea}>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const node = visibleRows[vi.index];
            const isError = node.span.statusCode === 'STATUS_CODE_ERROR';
            const isSelected = node.key === selectedSpanKey;
            const isMatched = searchTerm !== '' && isMatch(node);
            const hasChildren = node.children.length > 0;
            const isCollapsed = collapsed.has(node.key);

            const rawLeft = (node.startOffset - zoom.start) / winLen;
            const rawRight = (node.startOffset + node.widthFraction - zoom.start) / winLen;
            const dispLeft = clamp01(rawLeft);
            const dispRight = clamp01(rawRight);
            const dispWidth = Math.max(dispRight - dispLeft, 0);
            const kindIcon = SPAN_KIND_ICON[node.span.spanKind] ?? DEFAULT_KIND_ICON;

            return (
              <div
                key={node.key}
                className={`${styles.row} ${isSelected ? styles.rowSelected : ''} ${isMatched ? styles.rowMatched : ''}`}
                style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW_HEIGHT, transform: `translateY(${vi.start}px)` }}
                onClick={() => onSelectSpan(node)}
              >
                <div className={styles.labelCol}>
                  {/* Indent guides: one thin line per ancestor level */}
                  <div className={styles.indentGuides} style={{ width: node.depth * INDENT }}>
                    {Array.from({ length: node.depth }).map((_, i) => (
                      <div key={i} className={styles.indentLine} style={{ left: i * INDENT + INDENT / 2 }} />
                    ))}
                  </div>
                  {hasChildren ? (
                    <button
                      className={styles.collapseBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCollapse(node.key);
                      }}
                    >
                      <Icon name={isCollapsed ? 'angle-right' : 'angle-down'} size="sm" />
                    </button>
                  ) : (
                    <span className={styles.collapseSpacer} />
                  )}
                  {node.isOrphan && (
                    <Tooltip content="Parent span not found in this trace">
                      <Icon name="exclamation-triangle" size="sm" className={styles.orphanIcon} />
                    </Tooltip>
                  )}
                  <Tooltip content={node.span.spanKind || 'unknown kind'}>
                    <Icon name={kindIcon} size="sm" className={styles.kindIcon} />
                  </Tooltip>
                  <span
                    className={styles.serviceDot}
                    style={{ background: serviceColor(node.span.serviceName) }}
                    title={node.span.serviceName}
                  />
                  <span className={styles.serviceName} title={node.span.serviceName}>
                    {node.span.serviceName || node.span.spanId.slice(0, 8) || '(unknown)'}
                  </span>
                  <span className={styles.opName} title={node.span.operationName}>
                    {node.span.operationName || '(unnamed span)'}
                  </span>
                  {hasChildren && isCollapsed && <span className={styles.childBadge}>{countDescendants(node)}</span>}
                  {isError && <span className={styles.errorBadge}>ERR</span>}
                </div>
                <div className={styles.barCol}>
                  <div className={styles.barTrack}>
                    {dispWidth > 0 && (
                      <div
                        className={`${styles.bar} ${isError ? styles.barError : ''} ${node.isCriticalPath ? styles.barCritical : ''}`}
                        style={{
                          left: `${dispLeft * 100}%`,
                          width: `${Math.max(dispWidth * 100, 0.3)}%`,
                          background: isError ? undefined : serviceColor(node.span.serviceName),
                        }}
                        title={`${node.span.serviceName}: ${node.span.operationName} — ${formatNs(node.span.durationNs)}`}
                      >
                        <span className={styles.barLabel}>{formatNs(node.span.durationNs)}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function countDescendants(node: WaterfallNode): number {
  let count = 0;
  const stack = [...node.children];
  while (stack.length > 0) {
    const n = stack.pop()!;
    count++;
    for (const c of n.children) {
      stack.push(c);
    }
  }
  return count;
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  truncatedAlert: css`
    margin: 0 ${theme.spacing(1)} ${theme.spacing(1)};
  `,
  toolbar: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(1)};
    flex-wrap: wrap;
  `,
  search: css`
    flex: 1;
    min-width: 220px;
  `,
  matchNav: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.25)};
  `,
  matchCount: css`
    color: ${theme.colors.text.secondary};
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: 11px;
    min-width: 48px;
    text-align: center;
  `,
  headerRow: css`
    display: flex;
    border-bottom: 1px solid ${theme.colors.border.medium};
    padding: ${theme.spacing(0.5)} 0;
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
    background: ${theme.colors.background.secondary};
    position: sticky;
    top: 0;
    z-index: 2;
  `,
  scrollArea: css`
    flex: 1;
    min-height: 0;
    overflow: auto;
  `,
  labelCol: css`
    width: ${LABEL_WIDTH}px;
    min-width: ${LABEL_WIDTH}px;
    padding: 0 ${theme.spacing(1)};
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    overflow: hidden;
    position: relative;
  `,
  barCol: css`
    flex: 1;
    padding: 0 ${theme.spacing(1)};
  `,
  barAxis: css`
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: ${theme.colors.text.disabled};
    padding: 0 ${theme.spacing(0.5)};
  `,
  row: css`
    display: flex;
    align-items: center;
    border-bottom: 1px solid ${theme.colors.border.weak};
    cursor: pointer;
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  rowSelected: css`
    background: ${theme.colors.action.selected};
    &:hover {
      background: ${theme.colors.action.selected};
    }
  `,
  rowMatched: css`
    outline: 1px solid ${theme.colors.warning.border};
    outline-offset: -1px;
  `,
  indentGuides: css`
    position: relative;
    align-self: stretch;
    flex-shrink: 0;
  `,
  indentLine: css`
    position: absolute;
    top: -${ROW_HEIGHT / 2}px;
    bottom: -${ROW_HEIGHT / 2}px;
    width: 1px;
    background: ${theme.colors.border.weak};
  `,
  collapseBtn: css`
    background: transparent;
    border: none;
    cursor: pointer;
    color: ${theme.colors.text.secondary};
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    padding: 0;
    &:hover {
      color: ${theme.colors.text.primary};
    }
  `,
  collapseSpacer: css`
    width: 16px;
    flex-shrink: 0;
  `,
  orphanIcon: css`
    color: ${theme.colors.warning.text};
    flex-shrink: 0;
  `,
  kindIcon: css`
    color: ${theme.colors.text.secondary};
    flex-shrink: 0;
  `,
  serviceDot: css`
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  `,
  serviceName: css`
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 90px;
    flex-shrink: 0;
  `,
  opName: css`
    color: ${theme.colors.text.primary};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  `,
  childBadge: css`
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    color: ${theme.colors.text.secondary};
    font-size: 10px;
    padding: 0 4px;
    border-radius: 8px;
    flex-shrink: 0;
  `,
  errorBadge: css`
    background: ${theme.colors.error.main};
    color: ${theme.colors.error.contrastText};
    font-size: 10px;
    padding: 1px 4px;
    border-radius: 2px;
    flex-shrink: 0;
  `,
  barTrack: css`
    position: relative;
    height: 16px;
    background: ${theme.colors.background.secondary};
    border-radius: 2px;
  `,
  bar: css`
    position: absolute;
    top: 2px;
    height: 12px;
    border-radius: 2px;
    display: flex;
    align-items: center;
    min-width: 2px;
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
    transition: filter 0.1s;
    &:hover {
      filter: brightness(1.15);
    }
  `,
  barError: css`
    background: ${theme.colors.error.main};
    border-left: 2px solid ${theme.colors.error.text};
  `,
  barCritical: css`
    outline: 1px solid ${theme.colors.warning.main};
    outline-offset: 1px;
  `,
  barLabel: css`
    font-size: 10px;
    color: #fff;
    text-shadow: 0 1px 1px rgba(0, 0, 0, 0.4);
    white-space: nowrap;
    padding: 0 4px;
    overflow: hidden;
  `,
  empty: css`
    padding: ${theme.spacing(4)};
    text-align: center;
    color: ${theme.colors.text.secondary};
  `,
});
