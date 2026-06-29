import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, DateTime, dateTimeFormat, toUtc } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';
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
}

function severityColor(severity: unknown): string {
  const s = String(severity || '').toLowerCase();
  return SEVERITY_COLORS[s] ?? SEVERITY_COLORS['unknown'];
}

const TS_FORMAT = { format: 'YYYY-MM-DD HH:mm:ss.SSS', timeZone: 'browser' } as const;

function formatTimestamp(ts: unknown): string {
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
}: LogsTableProps) {
  const styles = useStyles2(getStyles);

  if (loading) {
    return <div className={styles.empty}>Loading…</div>;
  }
  if (!loading && rows.length === 0) {
    return <div className={styles.empty}>No logs found for the selected time range and filters.</div>;
  }

  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
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
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const isSelected = selectedRow === row;
            return (
              <tr
                key={i}
                className={`${styles.tr} ${isSelected ? styles.trSelected : ''}`}
                onClick={() => onRowClick(row)}
              >
                {columns.map((col) => (
                  <td
                    key={col.id}
                    className={`${styles.td} ${col.type === 'text' ? styles.bodyCell : ''}`}
                  >
                    <span
                      className={
                        col.type === 'time'
                          ? styles.timestamp
                          : col.type === 'level'
                          ? styles.severity
                          : col.type === 'text'
                          ? styles.body
                          : styles.cell
                      }
                    >
                      {renderCell(col, row)}
                    </span>
                  </td>
                ))}
              </tr>
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
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;
    font-size: ${theme.typography.bodySmall.fontSize};
    font-family: ${theme.typography.fontFamilyMonospace};
  `,
  th: css`
    padding: ${theme.spacing(0.75)} ${theme.spacing(1)};
    text-align: left;
    font-weight: ${theme.typography.fontWeightMedium};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    border-bottom: 1px solid ${theme.colors.border.medium};
    background: ${theme.colors.background.secondary};
    white-space: nowrap;
    position: sticky;
    top: 0;
    z-index: 1;
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
    cursor: pointer;
    border-bottom: 1px solid ${theme.colors.border.weak};
    &:hover { background: ${theme.colors.action.hover}; }
  `,
  trSelected: css`
    background: ${theme.colors.action.selected} !important;
  `,
  td: css`
    padding: ${theme.spacing(0.5)} ${theme.spacing(1)};
    vertical-align: top;
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
