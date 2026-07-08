/**
 * Side-by-side field diff for a handful of selected log rows — Kibana's "Compare selected"
 * action. Each selected row becomes a column; each distinct field across all selected rows
 * becomes a row, so it reads like a diff table (values that differ stand out visually).
 */
import React, { useMemo } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Modal, useStyles2 } from '@grafana/ui';
import { LogRow } from '../types';
import { formatTimestamp } from './LogsTable';
import { CORE_ALIAS } from '../sql/queryBuilder';

interface CompareLogsModalProps {
  rows: LogRow[];
  onDismiss: () => void;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) {
    return '—';
  }
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

export function CompareLogsModal({ rows, onDismiss }: CompareLogsModalProps) {
  const styles = useStyles2(getStyles);

  const fieldKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const row of rows) {
      for (const k of Object.keys(row)) {
        if (k) {
          keys.add(k);
        }
      }
    }
    // Timestamp first, then the rest alphabetically — a stable, readable order.
    return [...keys].sort((a, b) => {
      if (a === CORE_ALIAS.timestamp) return -1;
      if (b === CORE_ALIAS.timestamp) return 1;
      return a.localeCompare(b);
    });
  }, [rows]);

  return (
    <Modal title={`Compare ${rows.length} logs`} isOpen onDismiss={onDismiss}>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.fieldHeader}>Field</th>
              {rows.map((row, i) => (
                <th key={i} className={styles.rowHeader}>
                  {formatTimestamp(row[CORE_ALIAS.timestamp]) || `Log ${i + 1}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fieldKeys.map((key) => {
              const values = rows.map((row) => cellText(row[key]));
              const allSame = values.every((v) => v === values[0]);
              return (
                <tr key={key}>
                  <td className={styles.fieldCell}>{key}</td>
                  {values.map((v, i) => (
                    <td key={i} className={cx(styles.valueCell, !allSame && styles.valueDiffers)}>
                      {v}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  scroll: css`
    max-height: 70vh;
    overflow: auto;
  `,
  table: css`
    border-collapse: collapse;
    width: 100%;
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  fieldHeader: css`
    position: sticky;
    left: 0;
    top: 0;
    z-index: 2;
    background: ${theme.colors.background.secondary};
    text-align: left;
    padding: ${theme.spacing(0.75)} ${theme.spacing(1)};
    border-bottom: 1px solid ${theme.colors.border.medium};
    min-width: 160px;
  `,
  rowHeader: css`
    position: sticky;
    top: 0;
    z-index: 1;
    background: ${theme.colors.background.secondary};
    text-align: left;
    padding: ${theme.spacing(0.75)} ${theme.spacing(1)};
    border-bottom: 1px solid ${theme.colors.border.medium};
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    min-width: 200px;
  `,
  fieldCell: css`
    position: sticky;
    left: 0;
    background: ${theme.colors.background.primary};
    font-family: ${theme.typography.fontFamilyMonospace};
    color: ${theme.colors.text.secondary};
    padding: ${theme.spacing(0.5)} ${theme.spacing(1)};
    border-bottom: 1px solid ${theme.colors.border.weak};
    white-space: nowrap;
  `,
  valueCell: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    color: ${theme.colors.text.primary};
    padding: ${theme.spacing(0.5)} ${theme.spacing(1)};
    border-bottom: 1px solid ${theme.colors.border.weak};
    word-break: break-word;
    overflow-wrap: anywhere;
  `,
  valueDiffers: css`
    background: ${theme.colors.warning.transparent};
  `,
});
