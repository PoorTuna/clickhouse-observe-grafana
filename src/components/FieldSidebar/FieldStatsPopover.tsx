import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';
import { FieldModel } from '../../sql/fieldModel';
import { buildFieldTopValuesQuery } from '../../sql/queryBuilder';
import { runQueryRows } from '../../data/runQuery';
import { makeFilter } from '../../sql/filters';
import { FilterPill, LogsQueryState, SourceConfig } from '../../types';
import { SourceConfigContext } from '../App/App';

interface TopValue {
  value: string;
  count: number;
  pct: number;
}

interface FieldStatsPopoverProps {
  field: FieldModel;
  queryState: LogsQueryState;
  timeRange: TimeRange;
  onAddFilter: (f: FilterPill) => void;
  onAddColumn: () => void;
  isSelected: boolean;
}

export function FieldStatsPopover({
  field,
  queryState,
  timeRange,
  onAddFilter,
  onAddColumn,
  isSelected,
}: FieldStatsPopoverProps) {
  const styles = useStyles2(getStyles);
  const config: SourceConfig = useContext(SourceConfigContext);
  const [values, setValues] = useState<TopValue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    if (!config.datasourceUid) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const sql = buildFieldTopValuesQuery(config, queryState, field.sqlExpr, 10);
      const rows = await runQueryRows({ datasourceUid: config.datasourceUid, sql, timeRange });
      if (!mountedRef.current) {
        return;
      }
      const total = rows.reduce((s, r) => s + Number(r['count'] ?? 0), 0);
      setValues(
        rows.map((r) => ({
          value: String(r['value'] ?? ''),
          count: Number(r['count'] ?? 0),
          pct: total > 0 ? (Number(r['count'] ?? 0) / total) * 100 : 0,
        }))
      );
    } catch (e) {
      if (mountedRef.current) {
        setError(String((e as Error)?.message ?? e));
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [config, field.sqlExpr, queryState, timeRange]);

  useEffect(() => {
    mountedRef.current = true;
    load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.fieldName}>{field.displayName}</span>
        <button
          className={`${styles.colBtn} ${isSelected ? styles.colBtnActive : ''}`}
          onClick={onAddColumn}
          title={isSelected ? 'Remove column' : 'Add as column'}
        >
          <Icon name={isSelected ? 'minus' : 'plus'} size="sm" />
          {isSelected ? ' Remove column' : ' Add column'}
        </button>
      </div>

      {loading && <div className={styles.loading}>Loading…</div>}
      {error && <div className={styles.error}>{error}</div>}
      {!loading && !error && values.length === 0 && (
        <div className={styles.empty}>No values in time range</div>
      )}
      {!loading && values.map((v) => (
        <div key={v.value} className={styles.row}>
          <div className={styles.bar} style={{ width: `${Math.max(2, v.pct)}%` }} />
          <span className={styles.value}>{v.value || '(empty)'}</span>
          <span className={styles.count}>{v.count}</span>
          <span className={styles.pct}>{v.pct.toFixed(1)}%</span>
          <button
            className={styles.filterBtn}
            title="Filter for value"
            onClick={() => onAddFilter(makeFilter(field.sqlExpr, v.value, '='))}
          >
            <Icon name="plus-circle" size="xs" />
          </button>
          <button
            className={styles.filterBtn}
            title="Filter out value"
            onClick={() => onAddFilter(makeFilter(field.sqlExpr, v.value, '!='))}
          >
            <Icon name="minus-circle" size="xs" />
          </button>
        </div>
      ))}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  panel: css`
    width: 280px;
    padding: ${theme.spacing(1.5)};
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    box-shadow: ${theme.shadows.z2};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: ${theme.spacing(1)};
    gap: ${theme.spacing(1)};
  `,
  fieldName: css`
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  colBtn: css`
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px 6px;
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    background: transparent;
    color: ${theme.colors.text.secondary};
    cursor: pointer;
    font-size: 11px;
    white-space: nowrap;
    &:hover { background: ${theme.colors.action.hover}; color: ${theme.colors.text.primary}; }
  `,
  colBtnActive: css`
    border-color: ${theme.colors.primary.border};
    color: ${theme.colors.primary.text};
  `,
  loading: css`
    color: ${theme.colors.text.secondary};
    padding: ${theme.spacing(1)} 0;
    text-align: center;
  `,
  error: css`
    color: ${theme.colors.error.text};
    padding: ${theme.spacing(0.5)} 0;
  `,
  empty: css`
    color: ${theme.colors.text.secondary};
    padding: ${theme.spacing(0.5)} 0;
  `,
  row: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    position: relative;
    padding: 2px 0;
    overflow: hidden;
  `,
  bar: css`
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    background: ${theme.colors.primary.transparent};
    border-radius: 2px;
    z-index: 0;
  `,
  value: css`
    position: relative;
    z-index: 1;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: ${theme.colors.text.primary};
  `,
  count: css`
    position: relative;
    z-index: 1;
    color: ${theme.colors.text.secondary};
    min-width: 30px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  `,
  pct: css`
    position: relative;
    z-index: 1;
    color: ${theme.colors.text.secondary};
    min-width: 42px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  `,
  filterBtn: css`
    position: relative;
    z-index: 1;
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0 1px;
    color: ${theme.colors.text.disabled};
    &:hover { color: ${theme.colors.text.primary}; }
  `,
});
