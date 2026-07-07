import React, { useRef, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Icon, useStyles2, Portal } from '@grafana/ui';
import { FieldModel } from '../../sql/fieldModel';
import { FIELD_TYPE_ICONS } from './fieldIcons';
import { FieldStatsPopover } from './FieldStatsPopover';
import { FilterPill, LogsQueryState } from '../../types';
import { makeFilter } from '../../sql/filters';

interface FieldItemProps {
  field: FieldModel;
  isSelected: boolean;
  queryState: LogsQueryState;
  timeRange: TimeRange;
  onToggleColumn: (field: FieldModel) => void;
  onAddFilter: (f: FilterPill) => void;
  /** Overrides the visible label (e.g. the bare key inside a collapsed source-column group,
   *  where the group header already establishes the "ResourceAttributes." prefix). The
   *  `title` tooltip always shows field.sqlExpr regardless, so the full picture is one hover away. */
  labelOverride?: string;
  /** When set, this row doubles as a Map/JSON container column's own field row AND the
   *  collapsible header for its discovered children — filter/select still act on the raw
   *  container itself, the chevron only toggles which nested fields are visible below it. */
  expandable?: { isOpen: boolean; onToggle: () => void; childCount: number };
}

export function FieldItem({
  field,
  isSelected,
  queryState,
  timeRange,
  onToggleColumn,
  onAddFilter,
  labelOverride,
  expandable,
}: FieldItemProps) {
  const styles = useStyles2(getStyles);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 });
  const rowRef = useRef<HTMLDivElement>(null);

  const icon = FIELD_TYPE_ICONS[field.type] ?? 'question-circle';

  const openPopover = () => {
    if (rowRef.current) {
      const rect = rowRef.current.getBoundingClientRect();
      const POPOVER_W = 308;
      const POPOVER_H = 400; // conservative estimate

      // Prefer right of field row; flip left if it would overflow viewport
      const left =
        rect.right + 8 + POPOVER_W > window.innerWidth
          ? Math.max(8, rect.left - POPOVER_W - 8)
          : rect.right + 8;

      // Clamp top so popover doesn't go below viewport
      const top = Math.min(rect.top, Math.max(8, window.innerHeight - POPOVER_H - 8));

      setPopoverPos({ top, left });
    }
    setPopoverOpen(true);
  };

  return (
    <>
      <div
        ref={rowRef}
        className={`${styles.row} field-item-row ${isSelected ? styles.rowSelected : ''}`}
        title={field.sqlExpr}
        onClick={openPopover}
      >
        {expandable && (
          <button
            className={styles.expandBtn}
            title={expandable.isOpen ? 'Collapse' : 'Expand'}
            onClick={(e) => { e.stopPropagation(); expandable.onToggle(); }}
          >
            <Icon name={expandable.isOpen ? 'angle-down' : 'angle-right'} size="xs" />
          </button>
        )}
        <Icon name={icon as any} size="xs" className={styles.typeIcon} />
        <span className={styles.name}>{labelOverride ?? field.displayName}</span>
        {expandable && <span className={styles.childCount}>{expandable.childCount}</span>}
        <div className={`${styles.actions} field-item-actions`}>
          <button
            className={styles.actionBtn}
            title="Filter out rows that have this field"
            onClick={(e) => { e.stopPropagation(); onAddFilter(makeFilter(field.sqlExpr, '', '=')); }}
          >
            <Icon name="minus-circle" size="xs" />
          </button>
          <button
            className={`${styles.actionBtn} ${isSelected ? styles.actionBtnActive : ''}`}
            title={isSelected ? 'Remove from table' : 'Add to table'}
            onClick={(e) => { e.stopPropagation(); onToggleColumn(field); }}
          >
            <Icon name={isSelected ? 'minus' : 'plus'} size="xs" />
          </button>
        </div>
      </div>

      {popoverOpen && (
        <Portal>
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 9999,
            }}
            onClick={() => setPopoverOpen(false)}
          >
            <div
              style={{
                position: 'fixed',
                top: popoverPos.top,
                left: popoverPos.left,
                zIndex: 10000,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <FieldStatsPopover
                field={field}
                queryState={queryState}
                timeRange={timeRange}
                isSelected={isSelected}
                onAddFilter={(f) => {
                  onAddFilter(f);
                  setPopoverOpen(false);
                }}
                onAddColumn={() => {
                  onToggleColumn(field);
                  setPopoverOpen(false);
                }}
              />
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  row: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    padding: 3px ${theme.spacing(0.5)};
    border-radius: ${theme.shape.radius.default};
    cursor: pointer;
    &:hover {
      background: ${theme.colors.action.hover};
    }
    &:hover .field-item-actions {
      opacity: 1;
    }
  `,
  rowSelected: css`
    background: ${theme.colors.action.selected};
  `,
  typeIcon: css`
    flex-shrink: 0;
    color: ${theme.colors.text.secondary};
  `,
  name: css`
    flex: 1;
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.primary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ${theme.typography.fontFamilyMonospace};
  `,
  actions: css`
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.1s;
  `,
  actionBtn: css`
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 1px 3px;
    border-radius: ${theme.shape.radius.default};
    color: ${theme.colors.text.secondary};
    display: flex;
    align-items: center;
    &:hover {
      background: ${theme.colors.action.focus};
      color: ${theme.colors.text.primary};
    }
  `,
  actionBtnActive: css`
    color: ${theme.colors.primary.text};
  `,
  expandBtn: css`
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    /* Stretches to the row's full height and widens the clickable area well past the visible
     * chevron glyph — the old 14px-wide, unpadded button was an easy misclick that opened the
     * stats popover instead of toggling the group. Kept within the row's own box (no negative
     * margins) so it can't bleed into the tightly-packed rows above/below. */
    align-self: stretch;
    width: 22px;
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    color: ${theme.colors.text.secondary};
    &:hover {
      color: ${theme.colors.text.primary};
    }
  `,
  childCount: css`
    font-size: 11px;
    color: ${theme.colors.text.disabled};
    flex-shrink: 0;
  `,
});
