import React, { useMemo, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Icon, Input, useStyles2 } from '@grafana/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import { FieldModel } from '../../sql/fieldModel';
import { useFields } from '../FieldsContext';
import { FieldItem } from './FieldItem';
import { FilterPill, LogsQueryState, SelectedColumn, ColumnType } from '../../types';

/** Sanitize a field id into a SQL-safe alias. Shared with LogDetailDrawer's "add as column" action. */
export function makeColumnKey(id: string): string {
  return 'fld_' + id.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').slice(0, 40);
}

export function fieldToColumn(field: FieldModel): SelectedColumn {
  return {
    id: field.id,
    key: makeColumnKey(field.id),
    sqlExpr: field.sqlExpr,
    displayName: field.displayName,
    type: field.type as ColumnType,
    isCore: false,
  };
}

interface FieldSidebarProps {
  queryState: LogsQueryState;
  timeRange: TimeRange;
  onToggleColumn: (col: SelectedColumn) => void;
  onAddFilter: (f: FilterPill) => void;
  onCollapse: () => void;
}

export function FieldSidebar({
  queryState,
  timeRange,
  onToggleColumn,
  onAddFilter,
  onCollapse,
}: FieldSidebarProps) {
  const styles = useStyles2(getStyles);
  const { fields, loading, refresh } = useFields();
  const [nameFilter, setNameFilter] = useState('');

  const selectedIds = useMemo(
    () => new Set(queryState.columns.map((c) => c.id)),
    [queryState.columns]
  );

  // Single flat, filterable list of Phase A columns — Map/JSON columns show as one row each (their
  // keys are browsed on-demand via FieldKeysPopover, opened by clicking the row in FieldItem, not
  // flattened into the list here) — and no Available/Empty split. The Available/Empty split (a
  // filter-aware presence check via a dedicated sample query) was removed as part of the perf
  // plan's "Available/Empty split: removed entirely for now" — revisit later; see the plan's
  // explicit follow-ups.
  const { selected, unselected } = useMemo(() => {
    const lc = nameFilter.toLowerCase();
    const filtered = nameFilter
      ? fields.filter((f) => f.displayName.toLowerCase().includes(lc) || f.name.toLowerCase().includes(lc))
      : fields;
    return {
      selected: filtered.filter((f) => selectedIds.has(f.id)),
      unselected: filtered.filter((f) => !selectedIds.has(f.id)),
    };
  }, [fields, nameFilter, selectedIds]);

  // The unselected list is the one that scales with schema width — a table with hundreds of
  // columns, or Map/JSON columns that explode into thousands of discovered keys/paths, used to
  // render every one of them as a real DOM row with no windowing. Virtualize just this list
  // (react-virtual is already a dependency) — "Selected" stays plain since it's bounded by
  // however many columns the user has actually added to the grid.
  const listScrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: unselected.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => 32,
    overscan: 12,
  });

  return (
    <div className={styles.sidebar}>
      <div className={styles.header}>
        <span className={styles.title}>Fields</span>
        {loading && <Icon name="sync" size="xs" className={styles.spinner} />}
        <button className={styles.refreshBtn} onClick={refresh} title="Refresh field list">
          <Icon name="sync" size="xs" />
        </button>
        <button className={styles.refreshBtn} onClick={onCollapse} title="Collapse sidebar">
          <Icon name="angle-double-left" size="xs" />
        </button>
      </div>

      <Input
        prefix={<Icon name="search" />}
        placeholder="Filter fields"
        value={nameFilter}
        onChange={(e) => setNameFilter(e.currentTarget.value)}
        className={styles.search}
      />

      {selected.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionLabel}>Selected ({selected.length})</div>
          {selected.map((f) => (
            <FieldItem
              key={f.id}
              field={f}
              isSelected
              queryState={queryState}
              timeRange={timeRange}
              onToggleColumn={(field) => onToggleColumn(fieldToColumn(field))}
              onAddFilter={onAddFilter}
            />
          ))}
        </section>
      )}

      <section className={styles.availableSection}>
        <div className={styles.sectionLabel}>Fields ({unselected.length})</div>
        <div ref={listScrollRef} className={styles.availableScroll}>
          <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
            {rowVirtualizer.getVirtualItems().map((vRow) => {
              const f = unselected[vRow.index];
              return (
                <div
                  key={f.id}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${vRow.start}px)`,
                  }}
                >
                  <FieldItem
                    field={f}
                    isSelected={false}
                    queryState={queryState}
                    timeRange={timeRange}
                    onToggleColumn={(field) => onToggleColumn(fieldToColumn(field))}
                    onAddFilter={onAddFilter}
                  />
                </div>
              );
            })}
          </div>
          {!loading && fields.length === 0 && (
            <div className={styles.empty}>No fields discovered yet</div>
          )}
        </div>
      </section>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  sidebar: css`
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1.25)};
    /* Was overflow-y: auto on the whole sidebar — the field list now scrolls itself (see
     * availableScroll) so the virtualizer's getScrollElement() has a bounded, measurable
     * viewport instead of an ever-growing one. */
    overflow: hidden;
    border-right: 1px solid ${theme.colors.border.weak};
    padding: ${theme.spacing(1)};
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
  `,
  title: css`
    font-size: ${theme.typography.body.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex: 1;
  `,
  spinner: css`
    color: ${theme.colors.text.secondary};
    animation: spin 1s linear infinite;
    @keyframes spin { to { transform: rotate(360deg); } }
  `,
  refreshBtn: css`
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 2px;
    color: ${theme.colors.text.secondary};
    border-radius: ${theme.shape.radius.default};
    display: flex;
    align-items: center;
    &:hover { color: ${theme.colors.text.primary}; background: ${theme.colors.action.hover}; }
  `,
  search: css`
    font-size: ${theme.typography.body.fontSize};
    & input {
      padding-top: ${theme.spacing(1.25)};
      padding-bottom: ${theme.spacing(1.25)};
    }
  `,
  section: css`
    display: flex;
    flex-direction: column;
    gap: 1px;
  `,
  availableSection: css`
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    gap: 1px;
  `,
  availableScroll: css`
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  `,
  sectionLabel: css`
    font-size: 13px;
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
    padding: ${theme.spacing(0.5)} ${theme.spacing(0.5)} 2px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  `,
  empty: css`
    font-size: ${theme.typography.body.fontSize};
    color: ${theme.colors.text.disabled};
    padding: ${theme.spacing(1)} ${theme.spacing(0.5)};
  `,
});
