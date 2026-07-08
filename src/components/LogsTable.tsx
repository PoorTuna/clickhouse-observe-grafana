import React, { useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2, DateTime, dateTimeFormat, toUtc } from '@grafana/data';
import { Icon, IconButton, LoadingPlaceholder, EmptyState, useStyles2 } from '@grafana/ui';
import { LogRow, SelectedColumn } from '../types';
import { SEVERITY_COLORS } from '../constants';

interface LogsTableProps {
  rows: LogRow[];
  loading: boolean;
  columns: SelectedColumn[];
  sort?: { col: string; dir: 'asc' | 'desc' };
  onRowClick: (row: LogRow) => void;
  onSort?: (col: string) => void;
  onRemoveColumn?: (col: SelectedColumn) => void;
  onMoveColumn?: (id: string, direction: 'left' | 'right') => void;
  selectedRow?: LogRow | null;
  /** Wrap the message/body cell instead of truncating with an ellipsis. */
  wrapLines?: boolean;
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
  selectedRow,
  wrapLines = false,
}: LogsTableProps) {
  const styles = useStyles2(getStyles);
  // Roving keyboard focus, independent of `selectedRow` (which opens the detail panel).
  // Arrow keys move this; Enter opens the row under it.
  const [focusIndex, setFocusIndex] = useState(-1);
  // Inline expansion (Kibana-style): the chevron reveals a raw-JSON preview of the row without
  // opening the full detail panel. Independent of `selectedRow`/`onRowClick`, which is now only
  // triggered from the hover mini-menu's "Open detail" action, not by clicking the row.
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());

  const toggleExpanded = (i: number) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(i)) {
        next.delete(i);
      } else {
        next.add(i);
      }
      return next;
    });
  };

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
            <th className={cx(styles.th, styles.expandTh)} aria-hidden="true" />
            {columns.map((col, idx) => {
              const isSorted = sort?.col === col.key;
              return (
                <th
                  key={col.id}
                  className={styles.th}
                  style={col.type === 'time' ? { width: 190 } : col.type === 'level' ? { width: 80 } : undefined}
                >
                  <div className={styles.thInner}>
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
            <th className={cx(styles.th, styles.actionsTh)} aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const isSelected = selectedRow === row;
            const isFocused = focusIndex === i;
            const isExpanded = expandedRows.has(i);
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
                  <td className={cx(styles.td, styles.expandTd)}>
                    <button
                      className={styles.expandBtn}
                      title={isExpanded ? 'Collapse' : 'Expand'}
                      onClick={() => toggleExpanded(i)}
                    >
                      <Icon name={isExpanded ? 'angle-down' : 'angle-right'} size="xs" className={styles.expandIcon} />
                    </button>
                  </td>
                  {columns.map((col) => (
                    <td
                      key={col.id}
                      className={cx(styles.td, col.type === 'text' && styles.bodyCell)}
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
                    </td>
                  ))}
                  <td className={cx(styles.td, styles.actionsTd)}>
                    <div className={styles.rowActions}>
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
                      <IconButton
                        name="copy"
                        size="sm"
                        tooltip="Copy row as JSON"
                        aria-label="Copy row as JSON"
                        onClick={() => navigator.clipboard.writeText(JSON.stringify(row, null, 2))}
                      />
                    </div>
                  </td>
                </tr>
                {isExpanded && (
                  <tr className={styles.expandedRow}>
                    <td className={styles.td} />
                    <td className={styles.td} colSpan={columns.length + 1}>
                      <pre className={styles.expandedJson}>{JSON.stringify(row, null, 2)}</pre>
                    </td>
                  </tr>
                )}
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
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  th: css`
    padding: ${theme.spacing(0.75)} ${theme.spacing(1)};
    text-align: left;
    font-weight: ${theme.typography.fontWeightMedium};
    font-size: ${theme.typography.bodySmall.fontSize};
    font-family: ${theme.typography.fontFamily};
    color: ${theme.colors.text.secondary};
    border-bottom: 1px solid ${theme.colors.border.medium};
    background: ${theme.colors.background.secondary};
    background-clip: padding-box;
    white-space: nowrap;
    position: sticky;
    top: 0;
    z-index: 1;
    &:hover {
      background: ${theme.colors.action.hover};
    }
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
  actionsTh: css`
    width: 56px;
  `,
  actionsTd: css`
    width: 56px;
    text-align: right;
  `,
  rowActions: css`
    display: flex;
    gap: 2px;
    justify-content: flex-end;
    opacity: 0;
    tr:hover & { opacity: 1; }
  `,
  expandedRow: css`
    background: ${theme.colors.background.canvas};
    border-bottom: 1px solid ${theme.colors.border.weak};
  `,
  expandedJson: css`
    margin: 0;
    padding: ${theme.spacing(1)};
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
    color: ${theme.colors.text.primary};
    max-height: 300px;
    overflow-y: auto;
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
    padding: ${theme.spacing(0.75)} ${theme.spacing(1)};
    vertical-align: top;
    font-family: ${theme.typography.fontFamilyMonospace};
    line-height: 1.6;
  `,
  bodyCell: css`
    max-width: 0;
    width: 100%;
  `,
  timestamp: css`
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
    font-size: 11px;
    display: block;
    font-variant-numeric: tabular-nums;
  `,
  severity: css`
    font-weight: ${theme.typography.fontWeightMedium};
    font-size: 11px;
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
    color: ${theme.colors.text.secondary};
    font-size: 11px;
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
