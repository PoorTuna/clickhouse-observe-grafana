import React, { useMemo } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, DateTime, dateTimeFormat } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { LogRow } from '../types';
import { SEVERITY_COLORS } from '../constants';

interface LogsTableProps {
  rows: LogRow[];
  loading: boolean;
  onRowClick: (row: LogRow) => void;
  selectedRow?: LogRow | null;
}

function severityColor(severity: unknown): string {
  const s = String(severity || '').toLowerCase();
  return SEVERITY_COLORS[s] ?? SEVERITY_COLORS['unknown'];
}

function formatTimestamp(ts: unknown): string {
  if (ts === null || ts === undefined) {
    return '';
  }
  // Grafana DateTime is a dayjs object; plain ms number or ISO string also handled
  if (typeof ts === 'object' && ts !== null && 'valueOf' in ts) {
    return dateTimeFormat((ts as DateTime).valueOf(), { format: 'YYYY-MM-DD HH:mm:ss.SSS' });
  }
  if (typeof ts === 'number') {
    return dateTimeFormat(ts, { format: 'YYYY-MM-DD HH:mm:ss.SSS' });
  }
  return String(ts);
}

export function LogsTable({ rows, loading, onRowClick, selectedRow }: LogsTableProps) {
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
            <th className={styles.th} style={{ width: 190 }}>
              Time
            </th>
            <th className={styles.th} style={{ width: 80 }}>
              Level
            </th>
            <th className={styles.th}>Message</th>
            <th className={styles.th} style={{ width: 140 }}>
              Service
            </th>
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
                <td className={styles.td}>
                  <span className={styles.timestamp}>{formatTimestamp(row['timestamp'])}</span>
                </td>
                <td className={styles.td}>
                  <span
                    className={styles.severity}
                    style={{ color: severityColor(row['severity']) }}
                  >
                    {String(row['severity'] || '').toUpperCase() || '—'}
                  </span>
                </td>
                <td className={`${styles.td} ${styles.bodyCell}`}>
                  <span className={styles.body}>{String(row['body'] ?? '')}</span>
                </td>
                <td className={styles.td}>
                  <span className={styles.service}>{String(row['serviceName'] ?? '—')}</span>
                </td>
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
  tr: css`
    cursor: pointer;
    border-bottom: 1px solid ${theme.colors.border.weak};
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  trSelected: css`
    background: ${theme.colors.action.selected} !important;
  `,
  td: css`
    padding: ${theme.spacing(0.5)} ${theme.spacing(1)};
    vertical-align: top;
  `,
  timestamp: css`
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
    font-size: 11px;
  `,
  severity: css`
    font-weight: ${theme.typography.fontWeightMedium};
    font-size: 11px;
    white-space: nowrap;
  `,
  bodyCell: css`
    max-width: 0;
    width: 100%;
  `,
  body: css`
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: ${theme.colors.text.primary};
  `,
  service: css`
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
    font-size: 11px;
  `,
  empty: css`
    padding: ${theme.spacing(4)};
    text-align: center;
    color: ${theme.colors.text.secondary};
  `,
});
