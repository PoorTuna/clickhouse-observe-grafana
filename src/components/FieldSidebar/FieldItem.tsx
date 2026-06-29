import React, { useRef, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Icon, useStyles2, Portal } from '@grafana/ui';
import { FieldModel } from '../../sql/fieldModel';
import { FIELD_TYPE_ICONS } from './fieldIcons';
import { FieldStatsPopover } from './FieldStatsPopover';
import { FilterPill, LogsQueryState } from '../../types';

interface FieldItemProps {
  field: FieldModel;
  isSelected: boolean;
  queryState: LogsQueryState;
  timeRange: TimeRange;
  onToggleColumn: (field: FieldModel) => void;
  onAddFilter: (f: FilterPill) => void;
}

export function FieldItem({
  field,
  isSelected,
  queryState,
  timeRange,
  onToggleColumn,
  onAddFilter,
}: FieldItemProps) {
  const styles = useStyles2(getStyles);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 });
  const rowRef = useRef<HTMLDivElement>(null);

  const icon = FIELD_TYPE_ICONS[field.type] ?? 'question-circle';

  const openPopover = () => {
    if (rowRef.current) {
      const rect = rowRef.current.getBoundingClientRect();
      setPopoverPos({
        top: rect.top + window.scrollY,
        left: rect.right + 8,
      });
    }
    setPopoverOpen(true);
  };

  return (
    <>
      <div
        ref={rowRef}
        className={`${styles.row} ${isSelected ? styles.rowSelected : ''}`}
        title={field.sqlExpr}
      >
        <Icon name={icon as any} size="xs" className={styles.typeIcon} />
        <span className={styles.name}>{field.displayName}</span>
        <div className={styles.actions}>
          <button
            className={styles.actionBtn}
            title="Top values"
            onClick={openPopover}
          >
            <Icon name={'chart-bar' as any} size="xs" />
          </button>
          <button
            className={`${styles.actionBtn} ${isSelected ? styles.actionBtnActive : ''}`}
            title={isSelected ? 'Remove from table' : 'Add to table'}
            onClick={() => onToggleColumn(field)}
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
                position: 'absolute',
                top: popoverPos.top,
                left: popoverPos.left,
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
    cursor: default;
    &:hover {
      background: ${theme.colors.action.hover};
    }
    &:hover .field-actions {
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
    .field-item-row:hover & {
      opacity: 1;
    }
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
});
