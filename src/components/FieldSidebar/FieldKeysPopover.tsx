import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Icon, useStyles2, useTheme2 } from '@grafana/ui';
import { FieldModel } from '../../sql/fieldModel';
import { FIELD_TYPE_ICONS } from './fieldIcons';
import { fieldTypeColor } from './fieldTypeColors';
import { buildWhereConditions } from '../../sql/queryBuilder';
import { buildFieldIndex } from '../../sql/fields';
import { KeyEntry, loadColumnKeys, peekColumnKeys, buildMapKeyField } from '../../sql/keys';
import { LogsQueryState, SourceConfig } from '../../types';
import { errMsg } from '../../errMsg';
import { SourceConfigContext } from '../App/App';
import { useFields } from '../FieldsContext';

/**
 * Kibana-style on-demand key browse for a Map *container* column in the sidebar. Fires one bounded,
 * sampled query (buildMapKeysQuery) scoped to the current search/filters/time range, then lets the
 * user click a discovered key to open the existing FieldStatsPopover (top values) for it — this
 * component only lists keys, it never itself queries value distributions.
 *
 * Map only: a JSON column's paths are discovered for the whole table up front and published as
 * ordinary fields (FieldsContext Phase C), so a JSON column never opens this popover.
 *
 * Shares its fetch + cache (loadColumnKeys/keysCache, sql/keys.ts) with the search bar's
 * dot-drilldown map-key autocomplete (SearchBar.tsx) — browsing a column from either surface warms
 * the other.
 */

interface FieldKeysPopoverProps {
  /** The Map container column (field.source === 'column', field.type === 'map'). */
  field: FieldModel;
  queryState: LogsQueryState;
  timeRange: TimeRange;
  onSelectKey: (leaf: FieldModel) => void;
}

export function FieldKeysPopover({ field, queryState, timeRange, onSelectKey }: FieldKeysPopoverProps) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const config: SourceConfig = useContext(SourceConfigContext);
  // Same discovered-fields index every other WHERE-builder call site threads through — see
  // FieldStatsPopover's matching comment.
  const { fields } = useFields();
  const fieldIndex = useMemo(() => buildFieldIndex(fields), [fields]);
  const [keys, setKeys] = useState<KeyEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    if (!config.datasourceUid) {
      return;
    }
    const opts = {
      table: config.logsTable,
      conditions: buildWhereConditions(config, queryState, fieldIndex),
      timeRange,
      cacheKey: JSON.stringify([queryState.search, queryState.filters]),
    };
    const cached = peekColumnKeys(config.datasourceUid, field.name, timeRange, opts);
    if (cached) {
      setKeys(cached.keys);
      setTotal(cached.total);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await loadColumnKeys(config, field.name, opts);
      if (!mountedRef.current) {
        return;
      }
      setKeys(result.keys);
      setTotal(result.total);
    } catch (e) {
      if (mountedRef.current) {
        setError(errMsg(e));
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [config, field.name, queryState, timeRange, fieldIndex]);

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
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Icon
            name={typeIcon as any}
            size="sm"
            className={styles.headerIcon}
            style={{ color: fieldTypeColor(theme, field.type) }}
          />
          <span className={styles.fieldName}>{field.displayName}</span>
        </div>
      </div>

      <div className={styles.typeLabel}>{field.type}</div>
      <div className={styles.sectionLabel}>Keys</div>

      {loading && <div className={styles.loading}>Loading…</div>}
      {error && <div className={styles.errorText}>{error}</div>}
      {!loading && !error && keys.length === 0 && (
        <div className={styles.empty}>No keys found in the sampled rows</div>
      )}

      {!loading && !error && (
        <div className={styles.list}>
          {keys.map((k) => (
            <button key={k.key} className={styles.row} onClick={() => onSelectKey(buildMapKeyField(field.name, k))}>
              <span className={styles.keyName}>{k.key}</span>
              <Icon name="angle-right" size="xs" className={styles.rowChevron} />
            </button>
          ))}
        </div>
      )}

      {!loading && !error && total > 0 && (
        <div className={styles.caption}>Discovered from {total.toLocaleString()} records.</div>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  panel: css`
    width: 300px;
    max-height: 420px;
    display: flex;
    flex-direction: column;
    padding: ${theme.spacing(1.5)};
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    box-shadow: ${theme.shadows.z2};
    font-size: ${theme.typography.body.fontSize};
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
  `,
  fieldName: css`
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ${theme.typography.fontFamilyMonospace};
  `,
  typeLabel: css`
    color: ${theme.colors.text.disabled};
    font-size: 13px;
    margin-bottom: ${theme.spacing(1)};
    text-transform: capitalize;
  `,
  sectionLabel: css`
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
    font-size: 13px;
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
  list: css`
    overflow-y: auto;
    min-height: 0;
  `,
  row: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    width: 100%;
    padding: 4px 2px;
    background: transparent;
    border: none;
    border-radius: 2px;
    cursor: pointer;
    text-align: left;
    color: ${theme.colors.text.primary};
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  keyName: css`
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: 13px;
  `,
  rowChevron: css`
    flex-shrink: 0;
    color: ${theme.colors.text.disabled};
  `,
  caption: css`
    margin-top: ${theme.spacing(1)};
    color: ${theme.colors.text.disabled};
    font-size: 13px;
    font-style: italic;
  `,
});
