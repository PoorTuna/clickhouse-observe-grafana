import React from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, Icon } from '@grafana/ui';
import { FilterOp, FilterPill } from '../types';
import { filterLabel, removeFilter } from '../sql/filters';

const NEGATED_OPS: ReadonlySet<FilterOp> = new Set(['!=', 'not_contains', 'not_one_of', 'not_exists']);

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
      {filters.map((f) => {
        // filterLabel always starts with the bare field name followed by a space (e.g.
        // "Body = value", "Body exists") except when a custom label overrides it entirely —
        // splitting on the first space lets the field name render distinctly (Kibana colors it)
        // without needing filterLabel itself to return structured parts.
        const label = filterLabel(f);
        const spaceIdx = !f.label ? label.indexOf(' ') : -1;
        const fieldPart = spaceIdx > 0 ? label.slice(0, spaceIdx) : null;
        const restPart = spaceIdx > 0 ? label.slice(spaceIdx) : label;
        const negated = NEGATED_OPS.has(f.op);
        return (
          <span
            key={f.id}
            className={cx(styles.pill, negated ? styles.pillNegative : styles.pillPositive)}
            title={`${f.field} ${f.op} ${f.value}`}
          >
            <span className={styles.label}>
              {fieldPart && <span className={styles.fieldPart}>{fieldPart}</span>}
              {restPart}
            </span>
            <button
              className={styles.removeBtn}
              onClick={() => onRemove(f.id)}
              aria-label={`Remove filter ${label}`}
            >
              <Icon name="times" size="xs" />
            </button>
          </span>
        );
      })}
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
    gap: ${theme.spacing(0.75)};
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.pill};
    padding: ${theme.spacing(0.375)} ${theme.spacing(0.5)} ${theme.spacing(0.375)} ${theme.spacing(0.75)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.primary};
    max-width: 300px;
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  /** Polarity accent — matches Kibana's green (positive) / red (excluding) filter pills. */
  pillPositive: css`
    border-color: ${theme.colors.success.border};
  `,
  pillNegative: css`
    border-color: ${theme.colors.error.border};
  `,
  label: css`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  fieldPart: css`
    font-weight: ${theme.typography.fontWeightBold};
  `,
  removeBtn: css`
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 2px;
    border-radius: ${theme.shape.radius.default};
    display: flex;
    align-items: center;
    color: ${theme.colors.text.secondary};
    flex-shrink: 0;
    &:hover {
      color: ${theme.colors.text.primary};
      background: ${theme.colors.action.focus};
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
