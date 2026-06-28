import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, Icon } from '@grafana/ui';
import { FilterPill } from '../types';
import { filterLabel, removeFilter } from '../sql/filters';

interface FilterPillsProps {
  filters: FilterPill[];
  onChange: (filters: FilterPill[]) => void;
}

export function FilterPills({ filters, onChange }: FilterPillsProps) {
  const styles = useStyles2(getStyles);

  if (filters.length === 0) {
    return null;
  }

  const onRemove = (id: string) => {
    onChange(removeFilter(filters, id));
  };

  return (
    <div className={styles.container}>
      {filters.map((f) => (
        <span key={f.id} className={styles.pill} title={`${f.field} ${f.op} ${f.value}`}>
          <span className={styles.label}>{filterLabel(f)}</span>
          <button
            className={styles.removeBtn}
            onClick={() => onRemove(f.id)}
            aria-label={`Remove filter ${filterLabel(f)}`}
          >
            <Icon name="times" size="xs" />
          </button>
        </span>
      ))}
      {filters.length > 1 && (
        <button className={styles.clearAll} onClick={() => onChange([])}>
          Clear all
        </button>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${theme.spacing(0.5)};
    align-items: center;
  `,
  pill: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    background: ${theme.colors.primary.transparent};
    border: 1px solid ${theme.colors.primary.border};
    border-radius: ${theme.shape.radius.pill};
    padding: ${theme.spacing(0.25)} ${theme.spacing(0.75)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.primary.text};
    max-width: 300px;
  `,
  label: css`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  removeBtn: css`
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0;
    display: flex;
    align-items: center;
    color: ${theme.colors.primary.text};
    flex-shrink: 0;
    &:hover {
      color: ${theme.colors.error.text};
    }
  `,
  clearAll: css`
    background: transparent;
    border: none;
    cursor: pointer;
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    padding: ${theme.spacing(0.25)} ${theme.spacing(0.5)};
    &:hover {
      color: ${theme.colors.text.primary};
      text-decoration: underline;
    }
  `,
});
