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

/** Splits a pill's text into a leading "NOT" badge (Kibana's convention for negated exists/one_of
 *  filters — "NOT field is one of [...]" rather than filterLabel's "field is not one of [...]"),
 *  a bold field-name part, and the remaining plain text. filterLabel() itself stays unchanged
 *  (tests, tooltips, and AddFilterPopover's chip all depend on its exact wording) — this is a
 *  presentation-only transform local to how pills render. */
function pillText(f: FilterPill): { notPrefix: boolean; fieldPart: string | null; rest: string } {
  if (f.label) {
    return { notPrefix: false, fieldPart: null, rest: f.label };
  }
  if (f.op === 'not_exists') {
    return { notPrefix: true, fieldPart: f.field, rest: ' exists' };
  }
  if (f.op === 'not_one_of') {
    const vals = (f.values ?? [f.value]).filter(Boolean).join(', ');
    return { notPrefix: true, fieldPart: f.field, rest: ` is one of [${vals}]` };
  }
  const label = filterLabel(f);
  const spaceIdx = label.indexOf(' ');
  return {
    notPrefix: false,
    fieldPart: spaceIdx > 0 ? label.slice(0, spaceIdx) : null,
    rest: spaceIdx > 0 ? label.slice(spaceIdx) : label,
  };
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
        const { notPrefix, fieldPart, rest } = pillText(f);
        const negated = NEGATED_OPS.has(f.op);
        return (
          <span
            key={f.id}
            className={cx(styles.pill, negated ? styles.pillNegative : styles.pillPositive)}
            title={filterLabel(f)}
          >
            <span className={styles.label}>
              {notPrefix && <span className={styles.notPart}>NOT</span>}
              {fieldPart && <span className={styles.fieldPart}>{fieldPart}</span>}
              {rest}
            </span>
            <button
              className={styles.removeBtn}
              onClick={() => onRemove(f.id)}
              aria-label={`Remove filter ${filterLabel(f)}`}
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
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(0.5)} ${theme.spacing(0.75)} ${theme.spacing(0.5)} ${theme.spacing(1)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    max-width: 300px;
  `,
  /** Polarity accent — matches Kibana's vivid green (positive) / red (excluding) filter pills:
   *  a 2px saturated border plus a matching low-opacity tint, rather than a flat gray chip with
   *  only a subtle border-color hint. */
  pillPositive: css`
    border: 2px solid ${theme.colors.success.main};
    background: ${theme.colors.success.transparent};
    &:hover { background: ${theme.colors.success.transparent}; filter: brightness(1.3); }
  `,
  pillNegative: css`
    border: 2px solid ${theme.colors.error.main};
    background: ${theme.colors.error.transparent};
    &:hover { background: ${theme.colors.error.transparent}; filter: brightness(1.3); }
  `,
  label: css`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  notPart: css`
    font-weight: ${theme.typography.fontWeightBold};
    color: ${theme.colors.error.text};
    margin-right: ${theme.spacing(0.5)};
  `,
  fieldPart: css`
    font-weight: ${theme.typography.fontWeightBold};
    color: ${theme.colors.text.primary};
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
