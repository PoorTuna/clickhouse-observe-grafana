import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';
import { FieldModel } from '../../sql/fieldModel';
import { FIELD_TYPE_ICONS } from './fieldIcons';
import { buildFieldTopValuesQuery, buildWhereConditions } from '../../sql/queryBuilder';
import { runQueryRows } from '../../data/runQuery';
import { makeFilter } from '../../sql/filters';
import { FilterPill, LogsQueryState, SourceConfig } from '../../types';
import { SourceConfigContext } from '../App/App';
import { coarseTimeBucket } from '../FieldsContext';

interface TopValue {
  value: string;
  count: number;
  pct: number;
}

interface CacheEntry {
  values: TopValue[];
  total: number;
}

// Module-level cache: keyed by datasourceUid:sqlExpr:timeBucket:filtersHash.
// No TTL — invalidated naturally when the key changes (time/filters changed).
const topValuesCache = new Map<string, CacheEntry>();

function cacheKey(
  datasourceUid: string,
  sqlExpr: string,
  timeRange: TimeRange,
  queryState: LogsQueryState
): string {
  const bucket = coarseTimeBucket(timeRange);
  const filtersHash = JSON.stringify([queryState.search, queryState.filters]);
  return `${datasourceUid}:${sqlExpr}:${bucket}:${filtersHash}`;
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
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    if (!config.datasourceUid) {
      return;
    }

    const key = cacheKey(config.datasourceUid, field.sqlExpr, timeRange, queryState);
    const cached = topValuesCache.get(key);
    if (cached) {
      setValues(cached.values);
      setTotal(cached.total);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const sql = buildFieldTopValuesQuery(config, field.sqlExpr, {
        table: config.logsTable,
        conditions: buildWhereConditions(config, queryState),
        limit: 10,
        sampleSize: 500,
      });
      const rows = await runQueryRows({ datasourceUid: config.datasourceUid, sql, timeRange });
      if (!mountedRef.current) {
        return;
      }

      // total is the same for every row — from the CTE scalar subquery
      const sampleTotal = rows.length > 0 ? Number(rows[0]['total'] ?? 0) : 0;
      const mapped: TopValue[] = rows.map((r) => ({
        value: String(r['value'] ?? ''),
        count: Number(r['count'] ?? 0),
        pct: sampleTotal > 0 ? (Number(r['count'] ?? 0) / sampleTotal) * 100 : 0,
      }));

      topValuesCache.set(key, { values: mapped, total: sampleTotal });
      setValues(mapped);
      setTotal(sampleTotal);
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

  // load() fetches top values async and mirrors the result into state — an external fetch
  // synced to React, not a render-time update.
  useEffect(() => {
    mountedRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const typeIcon = FIELD_TYPE_ICONS[field.type] ?? 'question-circle';

  return (
    <div className={styles.panel}>
      {/* Header: type icon + field name */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Icon name={typeIcon as any} size="sm" className={styles.headerIcon} />
          <span className={styles.fieldName}>{field.displayName}</span>
        </div>
        <button
          className={`${styles.colBtn} ${isSelected ? styles.colBtnActive : ''}`}
          onClick={onAddColumn}
          title={isSelected ? 'Remove column' : 'Add as column'}
        >
          <Icon name={isSelected ? 'minus' : 'plus'} size="sm" />
          {isSelected ? ' Remove' : ' Add column'}
        </button>
      </div>

      {/* Field type subheader */}
      <div className={styles.typeLabel}>{field.type}</div>

      {/* Top values section */}
      <div className={styles.sectionLabel}>Top values</div>

      {loading && <div className={styles.loading}>Loading…</div>}
      {error && <div className={styles.errorText}>{error}</div>}
      {!loading && !error && values.length === 0 && (
        <div className={styles.empty}>No values in time range</div>
      )}

      {!loading &&
        !error &&
        values.map((v) => (
          <div key={v.value} className={styles.row} title={`${v.count.toLocaleString()} records`}>
            {/* % bar background */}
            <div className={styles.barBg} style={{ width: `${Math.max(2, v.pct)}%` }} />

            {/* Value text */}
            <span className={styles.value}>{v.value || '(empty)'}</span>

            {/* Percentage */}
            <span className={styles.pct}>{v.pct.toFixed(1)}%</span>

            {/* Filter buttons — revealed on row hover via CSS */}
            <div className={`${styles.filterBtns} field-filter-btns`}>
              <button
                className={styles.filterBtn}
                title={`Filter for ${field.displayName}: "${v.value}"`}
                onClick={() => onAddFilter(makeFilter(field.sqlExpr, v.value, '='))}
              >
                <Icon name="plus-circle" size="xs" />
              </button>
              <button
                className={styles.filterBtn}
                title={`Filter out ${field.displayName}: "${v.value}"`}
                onClick={() => onAddFilter(makeFilter(field.sqlExpr, v.value, '!='))}
              >
                <Icon name="minus-circle" size="xs" />
              </button>
            </div>
          </div>
        ))}

      {/* "Calculated from N records" caption */}
      {!loading && !error && total > 0 && (
        <div className={styles.caption}>Calculated from {total.toLocaleString()} records.</div>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  panel: css`
    width: 300px;
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
    gap: ${theme.spacing(1)};
    margin-bottom: 2px;
  `,
  headerLeft: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    overflow: hidden;
  `,
  headerIcon: css`
    flex-shrink: 0;
    color: ${theme.colors.text.secondary};
  `,
  fieldName: css`
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ${theme.typography.fontFamilyMonospace};
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
    flex-shrink: 0;
    &:hover {
      background: ${theme.colors.action.hover};
      color: ${theme.colors.text.primary};
    }
  `,
  colBtnActive: css`
    border-color: ${theme.colors.primary.border};
    color: ${theme.colors.primary.text};
  `,
  typeLabel: css`
    color: ${theme.colors.text.disabled};
    font-size: 11px;
    margin-bottom: ${theme.spacing(1)};
    text-transform: capitalize;
  `,
  sectionLabel: css`
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: ${theme.spacing(0.5)};
  `,
  loading: css`
    color: ${theme.colors.text.secondary};
    padding: ${theme.spacing(1)} 0;
    text-align: center;
  `,
  errorText: css`
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
    padding: 3px 0;
    overflow: hidden;
    border-radius: 2px;

    &:hover .field-filter-btns {
      opacity: 1;
    }
  `,
  barBg: css`
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    background: ${theme.colors.primary.transparent};
    border-radius: 2px;
    z-index: 0;
    pointer-events: none;
  `,
  value: css`
    position: relative;
    z-index: 1;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: ${theme.colors.text.primary};
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: 11px;
  `,
  pct: css`
    position: relative;
    z-index: 1;
    color: ${theme.colors.text.secondary};
    min-width: 38px;
    text-align: right;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  `,
  filterBtns: css`
    position: relative;
    z-index: 1;
    display: flex;
    gap: 1px;
    opacity: 0;
    transition: opacity 0.1s;
    flex-shrink: 0;
  `,
  filterBtn: css`
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0 2px;
    color: ${theme.colors.text.secondary};
    display: flex;
    align-items: center;
    &:hover {
      color: ${theme.colors.text.primary};
    }
  `,
  caption: css`
    margin-top: ${theme.spacing(1)};
    color: ${theme.colors.text.disabled};
    font-size: 11px;
    font-style: italic;
  `,
});
