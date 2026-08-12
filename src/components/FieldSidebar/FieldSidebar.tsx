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
  const { fields, loading, refresh, presence } = useFields();
  const [nameFilter, setNameFilter] = useState('');
  // Collapsed by default — matches Kibana's EmptyFields group (hideIfEmpty section the user opts
  // into), not persisted across sessions.
  const [emptyExpanded, setEmptyExpanded] = useState(false);

  const selectedIds = useMemo(
    () => new Set(queryState.columns.map((c) => c.id)),
    [queryState.columns]
  );

  // Fields render as a single flat, searchable list (no Map/JSON source-column grouping) —
  // nested attributes like ResourceAttributes.k8s.namespace.name show as their own row via
  // FieldModel.displayName, which already carries the full dotted path.
  //
  // "Available" vs "Empty" is a *post-filter* split (see useFieldPresence.ts) — a field discovered
  // in the schema that happens to have no values under the current search/filters/time range moves
  // to Empty, same as Kibana's sidebar. presence.present === null (not computed yet, or the
  // presence query failed) means "unknown" — everything stays in Available rather than guessing,
  // same fallback Kibana uses ("All fields" with no Empty section) when its existence fetch fails.
  const { selected, available, empty } = useMemo(() => {
    const lc = nameFilter.toLowerCase();
    const filtered = nameFilter
      ? fields.filter((f) => f.displayName.toLowerCase().includes(lc) || f.name.toLowerCase().includes(lc))
      : fields;
    const unselected = filtered.filter((f) => !selectedIds.has(f.id));
    const knowsPresence = presence.present !== null;
    return {
      selected: filtered.filter((f) => selectedIds.has(f.id)),
      available: knowsPresence ? unselected.filter((f) => presence.present!.has(f.id)) : unselected,
      empty: knowsPresence ? unselected.filter((f) => !presence.present!.has(f.id)) : [],
    };
  }, [fields, nameFilter, selectedIds, presence.present]);

  // The "Available" list is the one that scales with schema width — a table with hundreds of
  // columns, or Map/JSON columns that explode into thousands of discovered keys/paths, used to
  // render every one of them as a real DOM row with no windowing. Virtualize just this list
  // (react-virtual is already a dependency) — "Selected" stays plain since it's bounded by
  // however many columns the user has actually added to the grid.
  const availableScrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: available.length,
    getScrollElement: () => availableScrollRef.current,
    estimateSize: () => 32,
    overscan: 12,
  });

  // Empty section virtualizes too, same reasoning — it can hold just as many discovered Map/JSON
  // keys as Available once a filter narrows scope. Only mounted while expanded.
  const emptyScrollRef = useRef<HTMLDivElement>(null);
  const emptyVirtualizer = useVirtualizer({
    count: empty.length,
    getScrollElement: () => emptyScrollRef.current,
    estimateSize: () => 32,
    overscan: 12,
  });

  return (
    <div className={styles.sidebar}>
      <div className={styles.header}>
        <span className={styles.title}>Fields</span>
        {(loading || presence.loading) && <Icon name="sync" size="xs" className={styles.spinner} />}
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
        <div className={styles.sectionLabel}>
          {presence.status === 'ok' ? 'Available' : 'All'} fields ({available.length})
        </div>
        <div ref={availableScrollRef} className={styles.availableScroll}>
          <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
            {rowVirtualizer.getVirtualItems().map((vRow) => {
              const f = available[vRow.index];
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

      {/* Kibana's EmptyFields group: hidden entirely when there's nothing in it (hideIfEmpty),
          collapsed by default when there is. presence.present === null (unknown/failed) means
          this list is always empty — see the useMemo above — so nothing renders in that case,
          matching Kibana's own fallback to a single unsplit "All fields" list. */}
      {empty.length > 0 && (
        <section className={styles.emptySection}>
          <button
            className={styles.emptyHeader}
            onClick={() => setEmptyExpanded((v) => !v)}
            title="Fields that don't have any values based on your filters."
          >
            <Icon name={emptyExpanded ? 'angle-down' : 'angle-right'} size="xs" />
            <span className={styles.sectionLabel}>Empty fields ({empty.length})</span>
            <Icon name="info-circle" size="xs" className={styles.emptyInfoIcon} />
          </button>
          {emptyExpanded && (
            <div ref={emptyScrollRef} className={styles.emptyScroll}>
              <div style={{ height: emptyVirtualizer.getTotalSize(), position: 'relative' }}>
                {emptyVirtualizer.getVirtualItems().map((vRow) => {
                  const f = empty[vRow.index];
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
            </div>
          )}
        </section>
      )}
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
    /* Was overflow-y: auto on the whole sidebar — the "Available" section now scrolls itself
     * (see availableScroll) so the virtualizer's getScrollElement() has a bounded, measurable
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
  // Empty-fields section: fixed (not flex: 1, unlike availableSection) so it never competes with
  // Available for space while collapsed — only the expanded scroll area below claims height.
  emptySection: css`
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    max-height: 35%;
    gap: 1px;
  `,
  emptyHeader: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0;
    width: 100%;
    text-align: left;
    & > span { flex: 1; padding-left: 0; }
    &:hover { color: ${theme.colors.text.primary}; }
  `,
  emptyInfoIcon: css`
    color: ${theme.colors.text.disabled};
  `,
  emptyScroll: css`
    flex: 1;
    min-height: 0;
    max-height: 200px;
    overflow-y: auto;
  `,
});
