/**
 * Field / operator / value / custom-label form shared by "Add filter" and "Edit filter".
 * Renders the form body only — caller owns the Portal, backdrop, positioning, and title/footer.
 */

import React, { useEffect, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2, SelectableValue } from '@grafana/data';
import { Button, Select, Input, useStyles2 } from '@grafana/ui';
import { FilterPill, FilterOp } from '../../types';
import { makeFilter } from '../../sql/filters';
import { FieldValue } from '../../sql/kql/_values';
import { useFields } from '../FieldsContext';

interface OpDef {
  label: string;
  value: FilterOp;
  hasValue: boolean;
  isMulti: boolean;
}

export const OPERATORS: OpDef[] = [
  { label: 'is',              value: '=',           hasValue: true,  isMulti: false },
  { label: 'is not',          value: '!=',          hasValue: true,  isMulti: false },
  { label: 'is one of',       value: 'one_of',      hasValue: true,  isMulti: true  },
  { label: 'is not one of',   value: 'not_one_of',  hasValue: true,  isMulti: true  },
  { label: 'exists',          value: 'exists',      hasValue: false, isMulti: false },
  { label: 'does not exist',  value: 'not_exists',  hasValue: false, isMulti: false },
  { label: 'contains',        value: 'contains',    hasValue: true,  isMulti: false },
  { label: 'does not contain',value: 'not_contains',hasValue: true,  isMulti: false },
];

const OP_OPTIONS: Array<SelectableValue<FilterOp>> = OPERATORS.map((o) => ({
  label: o.label,
  value: o.value,
}));

export function opDef(op: FilterOp): OpDef {
  return OPERATORS.find((o) => o.value === op) ?? OPERATORS[0];
}

interface FilterEditFormProps {
  /** Existing pill to prefill (edit); omit for a blank "Add filter" form. */
  initial?: FilterPill;
  loadValues: (sqlExpr: string) => Promise<FieldValue[]>;
  onSubmit: (pill: FilterPill) => void;
  onCancel: () => void;
}

export function FilterEditForm({ initial, loadValues, onSubmit, onCancel }: FilterEditFormProps) {
  const styles = useStyles2(getStyles);
  const { fields } = useFields();

  const [selectedFieldExpr, setSelectedFieldExpr] = useState<string | null>(initial?.field ?? null);
  const [selectedOp, setSelectedOp] = useState<FilterOp>(initial?.op ?? '=');
  const [singleValue, setSingleValue] = useState(initial?.value ?? '');
  const [multiValues, setMultiValues] = useState<string[]>(initial?.values ?? []);
  const [customLabel, setCustomLabel] = useState(initial?.label ?? '');

  const [valueOptions, setValueOptions] = useState<Array<SelectableValue<string>>>([]);
  const [loadingValues, setLoadingValues] = useState(false);

  const fieldOptions: Array<SelectableValue<string>> = fields.map((f) => ({
    label: f.displayName,
    value: f.sqlExpr,
    description: f.sqlExpr !== f.displayName ? f.sqlExpr : undefined,
  }));

  // Load distinct values when field or op changes. This mirrors an async fetch (loadValues)
  // into state, so the reset-to-empty branch below is part of the same sync, not a
  // render-time side effect.
  useEffect(() => {
    const op = opDef(selectedOp);
    if (!selectedFieldExpr || !op.hasValue) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setValueOptions([]);
      return;
    }
    let cancelled = false;
    setLoadingValues(true);
    loadValues(selectedFieldExpr).then((vals) => {
      if (!cancelled) {
        setValueOptions(vals.map((v) => ({ label: v.value, value: v.value })));
        setLoadingValues(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedFieldExpr, selectedOp, loadValues]);

  const isValid = selectedFieldExpr !== null;
  const currentOp = opDef(selectedOp);

  const handleSubmit = () => {
    if (!selectedFieldExpr) {
      return;
    }
    const label = customLabel.trim() || undefined;

    let pill: FilterPill;
    if (!currentOp.hasValue) {
      pill = makeFilter(selectedFieldExpr, '', selectedOp, { label });
    } else if (currentOp.isMulti) {
      pill = makeFilter(selectedFieldExpr, '', selectedOp, { values: multiValues, label });
    } else {
      pill = makeFilter(selectedFieldExpr, singleValue, selectedOp, { label });
    }
    if (initial) {
      pill = { ...pill, id: initial.id, disabled: initial.disabled };
    }

    onSubmit(pill);
  };

  return (
    <>
      {/* Field / Operator / Value — one row, wide enough that none of the three obscures
          the others (they used to stack full-width in a much narrower panel). */}
      <div className={styles.fieldOpValueRow}>
        <div className={cx(styles.row, styles.rowInline)}>
          <label className={styles.label}>Field</label>
          <Select
            options={fieldOptions}
            value={selectedFieldExpr}
            onChange={(opt) => {
              setSelectedFieldExpr(opt.value ?? null);
              setSingleValue('');
              setMultiValues([]);
            }}
            placeholder="Select field"
            isClearable={false}
            isSearchable
            menuShouldPortal
          />
        </div>

        <div className={cx(styles.row, styles.rowInline)}>
          <label className={styles.label}>Operator</label>
          <Select
            options={OP_OPTIONS}
            value={selectedOp}
            onChange={(opt) => {
              setSelectedOp((opt.value as FilterOp) ?? '=');
              setSingleValue('');
              setMultiValues([]);
            }}
            isClearable={false}
            menuShouldPortal
          />
        </div>

        {/* Value input — only shown when op accepts a value */}
        {currentOp.hasValue && (
          <div className={cx(styles.row, styles.rowInline, styles.rowValue)}>
            <label className={styles.label}>Value</label>
            {currentOp.isMulti ? (
              <Select
                isMulti
                allowCustomValue
                options={valueOptions}
                isLoading={loadingValues}
                value={multiValues.map((v) => ({ label: v, value: v }))}
                onChange={(opts) => {
                  setMultiValues((opts as Array<SelectableValue<string>>).map((o) => o.value ?? ''));
                }}
                placeholder={selectedFieldExpr ? 'Select or type values…' : 'Select a field first'}
                disabled={!selectedFieldExpr}
                menuShouldPortal
              />
            ) : (
              <Select
                allowCustomValue
                options={valueOptions}
                isLoading={loadingValues}
                value={singleValue ? { label: singleValue, value: singleValue } : null}
                onChange={(opt) => setSingleValue((opt as SelectableValue<string>).value ?? '')}
                placeholder={selectedFieldExpr ? 'Select or type a value…' : 'Select a field first'}
                disabled={!selectedFieldExpr}
                menuShouldPortal
              />
            )}
          </div>
        )}
      </div>

      {/* Custom label */}
      <div className={styles.row}>
        <label className={styles.label}>
          Custom label <span className={styles.optional}>(optional)</span>
        </label>
        <Input
          value={customLabel}
          onChange={(e) => setCustomLabel(e.currentTarget.value)}
          placeholder="Add a custom label here"
        />
      </div>

      <div className={styles.actions}>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={!isValid}>
          {initial ? 'Update filter' : 'Add filter'}
        </Button>
      </div>
    </>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  fieldOpValueRow: css`
    display: flex;
    gap: ${theme.spacing(1.5)};
    align-items: flex-start;
    margin-bottom: ${theme.spacing(1.5)};
  `,
  row: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.5)};
    margin-bottom: ${theme.spacing(1.5)};
  `,
  rowInline: css`
    flex: 1;
    min-width: 0;
    margin-bottom: 0;
  `,
  /** Value needs more room than Field/Operator — it renders the longest placeholder text and,
   *  for "is one of", a row of selected-value pills. */
  rowValue: css`
    flex: 1.6;
  `,
  label: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
  `,
  optional: css`
    font-weight: ${theme.typography.fontWeightRegular};
    color: ${theme.colors.text.disabled};
  `,
  actions: css`
    display: flex;
    justify-content: flex-end;
    gap: ${theme.spacing(1)};
    margin-top: ${theme.spacing(0.5)};
  `,
});
