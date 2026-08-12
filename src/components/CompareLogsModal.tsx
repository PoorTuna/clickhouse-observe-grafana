/**
 * Side-by-side field diff for a handful of selected log rows — a "Compare selected" action.
 * Each selected row becomes a column; each distinct field across all selected rows becomes a
 * row, so it reads like a diff table (values that differ stand out visually).
 */
import React, { useMemo } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Modal, useStyles2 } from '@grafana/ui';
import { LogRow, SourceConfig } from '../types';
import { formatTimestamp } from './LogsTable';
import { CORE_ALIAS } from '../sql/queryBuilder';

interface CompareLogsModalProps {
  rows: LogRow[];
  /** Needed to find the timestamp value on a row: a hydrated (full-projection) row no longer
   *  carries CORE_ALIAS.timestamp — see H2 in the audit plan — only its real mapped column name,
   *  which only `config.columns.timestamp` tells us. */
  config: SourceConfig;
  onDismiss: () => void;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) {
    return '—';
  }
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Reads a row's timestamp value regardless of which projection produced it — grid rows carry
 *  CORE_ALIAS.timestamp, hydrated (SELECT *) rows only carry the real mapped column. */
function timestampOf(row: LogRow, timestampCol: string | undefined): unknown {
  return row[CORE_ALIAS.timestamp] ?? (timestampCol ? row[timestampCol] : undefined);
}

export function CompareLogsModal({ rows, config, onDismiss }: CompareLogsModalProps) {
  const styles = useStyles2(getStyles);
  const timestampCol = config.columns.timestamp;

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
      const aIsTimestamp = a === CORE_ALIAS.timestamp || a === timestampCol;
      const bIsTimestamp = b === CORE_ALIAS.timestamp || b === timestampCol;
      if (aIsTimestamp) {
        return -1;
      }
      if (bIsTimestamp) {
        return 1;
      }
      return a.localeCompare(b);
    });
  }, [rows, timestampCol]);

  return (
    <Modal title={`Compare ${rows.length} logs`} isOpen onDismiss={onDismiss}>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.fieldHeader}>Field</th>
              {rows.map((row, i) => (
                <th key={i} className={styles.rowHeader}>
                  {formatTimestamp(timestampOf(row, timestampCol)) || `Log ${i + 1}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fieldKeys.map((key) => {
              const values = rows.map((row) => cellText(row[key]));
              const reference = values[0];
              return (
                <tr key={key}>
                  <td className={styles.fieldCell}>{key}</td>
                  {values.map((v, i) => (
                    <td
                      key={i}
                      className={cx(
                        styles.valueCell,
                        i > 0 && (v === reference ? styles.valueMatches : styles.valueDiffers)
                      )}
                    >
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
    /* Default white-space: normal collapses embedded newlines in multi-line messages (e.g. stack
       traces) into one squashed line — pre-wrap keeps real line breaks while still wrapping long
       unbroken text at the cell width. */
    white-space: pre-wrap;
  `,
  valueMatches: css`
    color: ${theme.colors.success.text};
  `,
  valueDiffers: css`
    color: ${theme.colors.error.text};
  `,
});
