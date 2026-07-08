import React, { useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2, DateTime, dateTimeFormat, toUtc } from '@grafana/data';
import { Icon, IconButton, LoadingPlaceholder, EmptyState, useStyles2 } from '@grafana/ui';
import { FilterPill, LogRow, SelectedColumn } from '../types';
import { SEVERITY_COLORS } from '../constants';
import { makeFilter } from '../sql/filters';

interface LogsTableProps {
  rows: LogRow[];
  loading: boolean;
  columns: SelectedColumn[];
  sort?: { col: string; dir: 'asc' | 'desc' };
  onRowClick: (row: LogRow) => void;
  onSort?: (col: string) => void;
  onRemoveColumn?: (col: SelectedColumn) => void;
  onMoveColumn?: (id: string, direction: 'left' | 'right') => void;
  /** Drag-and-drop reorder: fired on drop with the dragged column's id and the id of the column
   *  it was dropped on. Omit to disable dragging (columns fall back to the move-left/right
   *  buttons only). */
  onMoveColumnTo?: (id: string, targetId: string) => void;
  selectedRow?: LogRow | null;
  /** Wrap the message/body cell instead of truncating with an ellipsis. */
  wrapLines?: boolean;
  /** Rows currently checked for comparison (by index within `rows`). Omit the pair to hide the
   *  checkbox column entirely. */
  compareSelection?: Set<number>;
  onToggleCompare?: (index: number) => void;
  /** Enables the per-cell hover toolbar (filter for/out, copy) — Kibana shows this floating just
   *  above whichever cell is under the cursor. Omit to hide it (e.g. read-only contexts). */
  onAddFilter?: (f: FilterPill) => void;
}

/** Shared with LogDetailDrawer's header summary so the row and detail view agree on color. */
export function severityColor(severity: unknown): string {
  const s = String(severity || '').toLowerCase();
  return SEVERITY_COLORS[s] ?? SEVERITY_COLORS['unknown'];
}

const TS_FORMAT = { format: 'YYYY-MM-DD HH:mm:ss.SSS', timeZone: 'browser' } as const;

/** Shared with LogDetailDrawer's header summary. */
export function formatTimestamp(ts: unknown): string {
  if (ts === null || ts === undefined) {
    return '';
  }
  if (typeof ts === 'object' && ts !== null && 'valueOf' in ts) {
    return dateTimeFormat((ts as DateTime).valueOf(), TS_FORMAT);
  }
  if (typeof ts === 'number') {
    return dateTimeFormat(ts, TS_FORMAT);
  }
  // Raw string from ClickHouse (e.g. "2026-06-29 06:00:00") — parse as UTC, display local.
  const ms = toUtc(String(ts)).valueOf();
  if (!isNaN(ms)) {
    return dateTimeFormat(ms, TS_FORMAT);
  }
  return String(ts);
}

function renderCell(col: SelectedColumn, row: LogRow): React.ReactNode {
  const raw = row[col.key];
  if (col.type === 'time') {
    return String(formatTimestamp(raw));
  }
  if (col.type === 'level') {
    const s = String(raw || '');
    return (
      <span style={{ color: severityColor(s) }}>
        {s.toUpperCase() || '—'}
      </span>
    );
  }
  if (raw === null || raw === undefined) {
    return '—';
  }
  if (typeof raw === 'object') {
    return JSON.stringify(raw);
  }
  return String(raw);
}

export function LogsTable({
  rows,
  loading,
  columns,
  sort,
  onRowClick,
  onSort,
  onRemoveColumn,
  onMoveColumn,
  onMoveColumnTo,
  selectedRow,
  wrapLines = false,
  compareSelection,
  onToggleCompare,
  onAddFilter,
}: LogsTableProps) {
  const showCompare = compareSelection !== undefined && onToggleCompare !== undefined;
  const styles = useStyles2(getStyles);
  // Roving keyboard focus, independent of `selectedRow` (which opens the detail panel).
  // Arrow keys move this; Enter opens the row under it.
  const [focusIndex, setFocusIndex] = useState(-1);
  // Column drag-and-drop reorder (native HTML5 DnD — no extra dependency). draggedId tracks
  // which column is being lifted (dimmed at its origin); dragOverId tracks the current drop
  // target (highlighted) so the user always sees where a drop would land.
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  if (loading) {
    return (
      <div className={styles.empty}>
        <LoadingPlaceholder text="Running query…" />
      </div>
    );
  }
  if (!loading && rows.length === 0) {
    return (
      <div className={styles.empty}>
        <EmptyState
          variant="not-found"
          hideImage
          message="No logs found for the selected time range and filters."
        />
      </div>
    );
  }

  const onTableKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIndex((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && focusIndex >= 0 && focusIndex < rows.length) {
      e.preventDefault();
      onRowClick(rows[focusIndex]);
    }
  };

  return (
    <div
      className={styles.tableWrapper}
      role="grid"
      tabIndex={0}
      onKeyDown={onTableKeyDown}
    >
      <table className={styles.table}>
        <thead>
          <tr>
            {showCompare && <th className={cx(styles.th, styles.compareTh)} aria-hidden="true" />}
            <th className={cx(styles.th, styles.expandTh)} aria-hidden="true" />
            {columns.map((col, idx) => {
              const isSorted = sort?.col === col.key;
              const draggable = Boolean(onMoveColumnTo);
              return (
                <th
                  key={col.id}
                  className={cx(
                    styles.th,
                    styles.dataTh,
                    draggable && styles.thDraggable,
                    draggedId === col.id && styles.thDragging,
                    dragOverId === col.id && dragOverId !== draggedId && styles.thDragOver
                  )}
                  style={col.type === 'time' ? { width: 190 } : col.type === 'level' ? { width: 80 } : undefined}
                  draggable={draggable}
                  onDragStart={(e) => {
                    setDraggedId(col.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={() => {
                    setDraggedId(null);
                    setDragOverId(null);
                  }}
                  onDragOver={(e) => {
                    if (!draggable) {
                      return;
                    }
                    e.preventDefault();
                    if (dragOverId !== col.id) {
                      setDragOverId(col.id);
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (draggedId && draggedId !== col.id) {
                      onMoveColumnTo!(draggedId, col.id);
                    }
                    setDraggedId(null);
                    setDragOverId(null);
                  }}
                >
                  <div className={styles.thInner}>
                    {draggable && (
                      <Icon name="draggabledots" size="sm" className={styles.dragHandle} title="Drag to reorder" />
                    )}
                    <span
                      className={onSort ? styles.sortable : ''}
                      onClick={() => onSort?.(col.key)}
                    >
                      {col.displayName}
                      {isSorted && (
                        <Icon
                          name={sort!.dir === 'asc' ? 'arrow-up' : 'arrow-down'}
                          size="xs"
                        />
                      )}
                    </span>
                    {!col.isCore && (
                      <div className={styles.colActions}>
                        {onMoveColumn && idx > 0 && (
                          <button
                            className={styles.colBtn}
                            title="Move left"
                            onClick={() => onMoveColumn(col.id, 'left')}
                          >
                            <Icon name="angle-left" size="xs" />
                          </button>
                        )}
                        {onMoveColumn && idx < columns.length - 1 && (
                          <button
                            className={styles.colBtn}
                            title="Move right"
                            onClick={() => onMoveColumn(col.id, 'right')}
                          >
                            <Icon name="angle-right" size="xs" />
                          </button>
                        )}
                        {onRemoveColumn && (
                          <button
                            className={styles.colBtn}
                            title="Remove column"
                            onClick={() => onRemoveColumn(col)}
                          >
                            <Icon name="times" size="xs" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const isSelected = selectedRow === row;
            const isFocused = focusIndex === i;
            const levelCol = columns.find((c) => c.type === 'level');
            const stripeColor = levelCol ? severityColor(row[levelCol.key]) : 'transparent';
            return (
              <React.Fragment key={i}>
                <tr
                  className={cx(styles.tr, isSelected && styles.trSelected, isFocused && styles.trFocused)}
                  style={{ borderLeftColor: stripeColor }}
                  onMouseDown={() => setFocusIndex(i)}
                  aria-selected={isSelected}
                >
                  {showCompare && (
                    <td className={cx(styles.td, styles.compareTd)}>
                      <input
                        type="checkbox"
                        checked={compareSelection!.has(i)}
                        onChange={() => onToggleCompare!(i)}
                        aria-label="Select for comparison"
                      />
                    </td>
                  )}
                  <td className={cx(styles.td, styles.expandTd)}>
                    <button
                      className={styles.expandBtn}
                      title="Open detail"
                      onClick={() => {
                        setFocusIndex(i);
                        onRowClick(row);
                      }}
                    >
                      <Icon name="expand-arrows" size="xs" className={styles.expandIcon} />
                    </button>
                  </td>
                  {columns.map((col) => {
                    const rawValue = row[col.key];
                    const filterable = onAddFilter && rawValue !== null && rawValue !== undefined && typeof rawValue !== 'object';
                    return (
                      <td
                        key={col.id}
                        className={cx(styles.td, styles.dataTd, col.type === 'text' && styles.bodyCell)}
                      >
                        <span
                          className={cx(
                            col.type === 'time'
                              ? styles.timestamp
                              : col.type === 'level'
                              ? styles.severity
                              : col.type === 'text'
                              ? styles.body
                              : styles.cell,
                            col.type === 'text' && wrapLines && styles.wrapped
                          )}
                        >
                          {renderCell(col, row)}
                        </span>
                        <div className={cx(styles.cellToolbar, 'cell-toolbar')}>
                            {filterable && (
                              <>
                                <IconButton
                                  name="search-plus"
                                  size="sm"
                                  tooltip="Filter for value"
                                  aria-label={`Filter for ${col.displayName}`}
                                  onClick={() => onAddFilter!(makeFilter(col.sqlExpr, String(rawValue), '='))}
                                />
                                <IconButton
                                  name="search-minus"
                                  size="sm"
                                  tooltip="Filter out value"
                                  aria-label={`Filter out ${col.displayName}`}
                                  onClick={() => onAddFilter!(makeFilter(col.sqlExpr, String(rawValue), '!='))}
                                />
                              </>
                            )}
                            <IconButton
                              name="copy"
                              size="sm"
                              tooltip="Copy value"
                              aria-label={`Copy ${col.displayName}`}
                              onClick={() =>
                                navigator.clipboard.writeText(
                                  rawValue !== null && typeof rawValue === 'object'
                                    ? JSON.stringify(rawValue)
                                    : String(rawValue ?? '')
                                )
                              }
                            />
                            <IconButton
                              name="table"
                              size="sm"
                              tooltip="Open detail"
                              aria-label="Open log detail"
                              onClick={() => {
                                setFocusIndex(i);
                                onRowClick(row);
                              }}
                            />
                        </div>
                      </td>
                    );
                  })}
                </tr>
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  tableWrapper: css`
    overflow-x: auto;
    overflow-y: auto;
    flex: 1;
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
    outline: none;
    &:focus-visible {
      box-shadow: inset 0 0 0 2px ${theme.colors.primary.border};
    }
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  `,
  th: css`
    padding: ${theme.spacing(0.75)} ${theme.spacing(1)};
    text-align: left;
    font-weight: ${theme.typography.fontWeightMedium};
    font-size: ${theme.typography.body.fontSize};
    font-family: ${theme.typography.fontFamily};
    color: ${theme.colors.text.secondary};
    border-bottom: 1px solid ${theme.colors.border.medium};
    background: ${theme.colors.background.secondary};
    background-clip: padding-box;
    white-space: nowrap;
    position: sticky;
    top: 0;
    z-index: 1;
  `,
  /** Hover feedback only for real data-column headers — the leading checkbox/expand-chevron
   *  header cells aren't interactive and shouldn't visually react on hover. */
  dataTh: css`
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  thDraggable: css`
    cursor: grab;
  `,
  thDragging: css`
    opacity: 0.4;
  `,
  thDragOver: css`
    box-shadow: inset 2px 0 0 0 ${theme.colors.primary.main};
    background: ${theme.colors.action.hover};
  `,
  dragHandle: css`
    flex-shrink: 0;
    color: ${theme.colors.text.disabled};
    cursor: grab;
  `,
  expandTh: css`
    width: 24px;
    padding-left: ${theme.spacing(1)};
    padding-right: 0;
  `,
  expandTd: css`
    width: 24px;
    padding-left: ${theme.spacing(1)};
    padding-right: 0;
  `,
  compareTh: css`
    width: 28px;
    padding-left: ${theme.spacing(1)};
    padding-right: 0;
  `,
  compareTd: css`
    width: 28px;
    padding-left: ${theme.spacing(1)};
    padding-right: 0;
  `,
  expandIcon: css`
    color: ${theme.colors.text.disabled};
  `,
  expandBtn: css`
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 2px;
    display: flex;
    align-items: center;
    border-radius: 2px;
    &:hover { background: ${theme.colors.action.hover}; }
    &:hover .expand-icon { color: ${theme.colors.text.primary}; }
  `,
  thInner: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
  `,
  sortable: css`
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 2px;
    &:hover { color: ${theme.colors.text.primary}; }
  `,
  colActions: css`
    display: flex;
    gap: 1px;
    margin-left: auto;
    opacity: 0;
    th:hover & { opacity: 1; }
  `,
  colBtn: css`
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 1px 2px;
    color: ${theme.colors.text.secondary};
    display: flex;
    align-items: center;
    border-radius: 2px;
    &:hover { color: ${theme.colors.text.primary}; background: ${theme.colors.action.hover}; }
  `,
  tr: css`
    border-bottom: 1px solid ${theme.colors.border.weak};
    border-left: 2px solid transparent;
    background: ${theme.colors.background.primary};
    transition: background-color 150ms ease;
    &:nth-of-type(even) { background: ${theme.colors.background.secondary}; }
    &:hover { background: ${theme.colors.action.hover}; }
    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,
  trSelected: css`
    background: ${theme.colors.action.selected} !important;
  `,
  trFocused: css`
    box-shadow: inset 0 0 0 1px ${theme.colors.primary.border};
  `,
  td: css`
    padding: ${theme.spacing(2)} ${theme.spacing(1.5)};
    vertical-align: top;
    font-family: ${theme.typography.fontFamilyMonospace};
    line-height: 1.5;
  `,
  dataTd: css`
    position: relative;
    &:hover {
      box-shadow: inset 0 0 0 1px ${theme.colors.primary.border};
    }
    &:hover .cell-toolbar {
      opacity: 1;
      pointer-events: auto;
    }
  `,
  cellToolbar: css`
    position: absolute;
    top: -14px;
    left: ${theme.spacing(0.5)};
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 1px;
    padding: 1px ${theme.spacing(0.25)};
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    box-shadow: ${theme.shadows.z1};
    opacity: 0;
    pointer-events: none;
    transition: opacity 100ms ease;
    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,
  bodyCell: css`
    max-width: 0;
    width: 100%;
  `,
  timestamp: css`
    color: ${theme.colors.text.primary};
    white-space: nowrap;
    font-size: 14px;
    display: block;
    font-variant-numeric: tabular-nums;
  `,
  severity: css`
    font-weight: ${theme.typography.fontWeightMedium};
    font-size: 14px;
    white-space: nowrap;
    display: block;
  `,
  body: css`
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: ${theme.colors.text.primary};
  `,
  wrapped: css`
    white-space: pre-wrap;
    word-break: break-word;
  `,
  cell: css`
    color: ${theme.colors.text.primary};
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
    display: block;
  `,
  empty: css`
    padding: ${theme.spacing(4)};
    text-align: center;
    color: ${theme.colors.text.secondary};
  `,
});
