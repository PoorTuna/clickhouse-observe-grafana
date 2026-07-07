import React, { useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Icon, Input, useStyles2 } from '@grafana/ui';
import { FieldModel } from '../../sql/fieldModel';
import { useFields } from '../FieldsContext';
import { FieldItem } from './FieldItem';
import { FilterPill, LogsQueryState, SelectedColumn, ColumnType } from '../../types';

/** Sanitize a field id into a SQL-safe alias. Shared with LogDetailDrawer's "add as column" action. */
export function makeColumnKey(id: string): string {
  return 'fld_' + id.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').slice(0, 40);
}

function fieldToColumn(field: FieldModel): SelectedColumn {
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

/** Group key + display label for a nested (map/json) field's source column. */
function groupKeyFor(f: FieldModel): string | null {
  if (f.source === 'map') {
    return f.mapColumn ?? null;
  }
  if (f.source === 'json') {
    return f.jsonColumn ?? null;
  }
  return null;
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
  // Nested (Map/JSON) fields are grouped by source column and collapsed by default — a table
  // can easily have hundreds of discovered attribute keys/paths, and most of the time a user
  // wants "the columns" not "every nested attribute ever seen." Expand on demand instead.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const selectedIds = useMemo(
    () => new Set(queryState.columns.map((c) => c.id)),
    [queryState.columns]
  );

  const { selected, available } = useMemo(() => {
    const lc = nameFilter.toLowerCase();
    const filtered = nameFilter
      ? fields.filter((f) => f.displayName.toLowerCase().includes(lc) || f.name.toLowerCase().includes(lc))
      : fields;
    return {
      selected: filtered.filter((f) => selectedIds.has(f.id)),
      available: filtered.filter((f) => !selectedIds.has(f.id)),
    };
  }, [fields, nameFilter, selectedIds]);

  // Split "available" into real top-level columns (shown flat, as before) and nested map/json
  // fields (grouped by source column). The raw Map/JSON container column itself (e.g. the whole
  // "ResourceAttributes" column) still gets its own row with full filter/select actions — it's
  // just also the collapsible header for its discovered children, rather than a second, separate
  // entry. Without a header row of its own (a plain <button>, no field behind it), there was no
  // way to filter out or select the container as a whole once it had children — this fixes that.
  const { plainColumns, groups } = useMemo(() => {
    const childrenByCol = new Map<string, FieldModel[]>();
    for (const f of available) {
      const key = groupKeyFor(f);
      if (key) {
        if (!childrenByCol.has(key)) {
          childrenByCol.set(key, []);
        }
        childrenByCol.get(key)!.push(f);
      }
    }
    const plainColumns: FieldModel[] = [];
    const groups: Array<{ container: FieldModel; children: FieldModel[] }> = [];
    for (const f of available) {
      if (f.source !== 'column') {
        continue;
      }
      const children = (f.type === 'map' || f.type === 'json') ? childrenByCol.get(f.name) : undefined;
      if (children && children.length > 0) {
        groups.push({ container: f, children });
      } else {
        plainColumns.push(f);
      }
    }
    return { plainColumns, groups };
  }, [available]);

  // Search should find nested fields regardless of collapse state — bypassing grouping when
  // searching is simpler and more useful than auto-expanding whichever groups matched.
  const searching = nameFilter.trim().length > 0;

  return (
    <div className={styles.sidebar}>
      <div className={styles.header}>
        <span className={styles.title}>Fields</span>
        {loading && <Icon name="sync" size="xs" className={styles.spinner} />}
        <button className={styles.refreshBtn} onClick={refresh} title="Refresh field list">
          <Icon name="sync" size="xs" />
        </button>
        <button className={styles.refreshBtn} onClick={onCollapse} title="Collapse sidebar">
          <Icon name="angle-left" size="xs" />
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

      <section className={styles.section}>
        <div className={styles.sectionLabel}>Available ({available.length})</div>
        {(searching ? available : plainColumns).map((f) => (
          <FieldItem
            key={f.id}
            field={f}
            isSelected={false}
            queryState={queryState}
            timeRange={timeRange}
            onToggleColumn={(field) => onToggleColumn(fieldToColumn(field))}
            onAddFilter={onAddFilter}
          />
        ))}
        {!searching &&
          groups.map(({ container, children }) => {
            const isOpen = expandedGroups.has(container.name);
            return (
              <div key={container.id}>
                <FieldItem
                  field={container}
                  isSelected={false}
                  queryState={queryState}
                  timeRange={timeRange}
                  onToggleColumn={(field) => onToggleColumn(fieldToColumn(field))}
                  onAddFilter={onAddFilter}
                  expandable={{ isOpen, onToggle: () => toggleGroup(container.name), childCount: children.length }}
                />
                {isOpen &&
                  children.map((f) => (
                    <FieldItem
                      key={f.id}
                      field={f}
                      isSelected={false}
                      queryState={queryState}
                      timeRange={timeRange}
                      onToggleColumn={(field) => onToggleColumn(fieldToColumn(field))}
                      onAddFilter={onAddFilter}
                      labelOverride={f.name}
                    />
                  ))}
              </div>
            );
          })}
        {!loading && fields.length === 0 && (
          <div className={styles.empty}>No fields discovered yet</div>
        )}
      </section>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  sidebar: css`
    width: 220px;
    min-width: 160px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    overflow-y: auto;
    border-right: 1px solid ${theme.colors.border.weak};
    padding-right: ${theme.spacing(1)};
    padding-top: ${theme.spacing(0.5)};
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
  `,
  title: css`
    font-size: ${theme.typography.bodySmall.fontSize};
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
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  section: css`
    display: flex;
    flex-direction: column;
    gap: 1px;
  `,
  sectionLabel: css`
    font-size: 11px;
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
    padding: ${theme.spacing(0.5)} ${theme.spacing(0.5)} 2px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  `,
  empty: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.disabled};
    padding: ${theme.spacing(1)} ${theme.spacing(0.5)};
  `,
});
