/**
 * Kibana-style "Add filter" button + popup for the Logs Explorer toolbar.
 *
 * Opens a panel with:
 *   Field selector → Operator selector → Value input (with live autocomplete)
 *   → optional Custom label → Cancel / Add filter
 *
 * Calls onAddFilter(pill) on submit; the pill is built with makeFilter so
 * multi-value (one_of / not_one_of) and custom label are preserved.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2, SelectableValue } from '@grafana/data';
import { Button, Icon, Input, Portal, Select, useStyles2 } from '@grafana/ui';
import { FilterPill, FilterOp } from '../../types';
import { makeFilter } from '../../sql/filters';
import { FieldValue } from '../../sql/kql/_values';
import { useFields } from '../FieldsContext';

// ── Operator definitions (Kibana ordering) ────────────────────────────────────

interface OpDef {
  label: string;
  value: FilterOp;
  hasValue: boolean;
  isMulti: boolean;
}

const OPERATORS: OpDef[] = [
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

function opDef(op: FilterOp): OpDef {
  return OPERATORS.find((o) => o.value === op) ?? OPERATORS[0];
}

// ── Component ─────────────────────────────────────────────────────────────────

interface AddFilterPopoverProps {
  /** Page-supplied value lookup (Logs and Traces each bind their own table/filters). */
  loadValues: (sqlExpr: string) => Promise<FieldValue[]>;
  onAddFilter: (pill: FilterPill) => void;
}

export function AddFilterPopover({ loadValues, onAddFilter }: AddFilterPopoverProps) {
  const styles = useStyles2(getStyles);
  const { fields } = useFields();

  const anchorRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 });

  // Form state
  const [selectedFieldExpr, setSelectedFieldExpr] = useState<string | null>(null);
  const [selectedOp, setSelectedOp] = useState<FilterOp>('=');
  const [singleValue, setSingleValue] = useState('');
  const [multiValues, setMultiValues] = useState<string[]>([]);
  const [customLabel, setCustomLabel] = useState('');

  // Value autocomplete
  const [valueOptions, setValueOptions] = useState<Array<SelectableValue<string>>>([]);
  const [loadingValues, setLoadingValues] = useState(false);

  // Field dropdown options
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

  const openPopover = useCallback(() => {
    if (anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      const PANEL_W = 640;
      const left = Math.min(rect.left, window.innerWidth - PANEL_W - 8);
      setPopoverPos({ top: rect.bottom + 6, left: Math.max(8, left) });
    }
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    // Reset form
    setSelectedFieldExpr(null);
    setSelectedOp('=');
    setSingleValue('');
    setMultiValues([]);
    setCustomLabel('');
    setValueOptions([]);
  }, []);

  const isValid = selectedFieldExpr !== null;
  const currentOp = opDef(selectedOp);

  const onSubmit = () => {
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

    onAddFilter(pill);
    close();
  };

  return (
    <div ref={anchorRef} className={styles.wrapper}>
      <button className={styles.triggerBtn} onClick={openPopover} title="Add a structured filter">
        <Icon name="plus" size="sm" />
        Add filter
      </button>

      {isOpen && (
        <Portal>
          {/* Click-outside backdrop */}
          <div className={styles.backdrop} onClick={close} />

          <div
            className={styles.panel}
            style={{ top: popoverPos.top, left: popoverPos.left }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className={styles.panelHeader}>
              <span className={styles.panelTitle}>Add filter</span>
            </div>

            {/* Field / Operator / Value — one row, Kibana-width, so none of the three obscures
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
                <div className={cx(styles.row, styles.rowInline)}>
                  <label className={styles.label}>Value</label>
                  {currentOp.isMulti ? (
                    <Select
                      isMulti
                      allowCustomValue
                      options={valueOptions}
                      isLoading={loadingValues}
                      value={multiValues.map((v) => ({ label: v, value: v }))}
                      onChange={(opts) => {
                        setMultiValues(
                          (opts as Array<SelectableValue<string>>).map((o) => o.value ?? '')
                        );
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

            {/* Actions */}
            <div className={styles.actions}>
              <Button variant="secondary" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={onSubmit} disabled={!isValid}>
                Add filter
              </Button>
            </div>
          </div>
        </Portal>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css`
    position: relative;
    display: inline-flex;
    align-items: center;
  `,
  triggerBtn: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    padding: ${theme.spacing(0.5)} ${theme.spacing(1)};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    background: transparent;
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    cursor: pointer;
    white-space: nowrap;
    height: 32px;
    &:hover {
      background: ${theme.colors.action.hover};
      color: ${theme.colors.text.primary};
      border-color: ${theme.colors.border.strong};
    }
  `,
  backdrop: css`
    position: fixed;
    inset: 0;
    z-index: 9999;
  `,
  panel: css`
    position: fixed;
    z-index: 10000;
    width: 640px;
    max-width: calc(100vw - 16px);
    padding: ${theme.spacing(2)};
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    box-shadow: ${theme.shadows.z3};
  `,
  fieldOpValueRow: css`
    display: flex;
    gap: ${theme.spacing(1.5)};
    align-items: flex-start;
    margin-bottom: ${theme.spacing(1.5)};
  `,
  panelHeader: css`
    margin-bottom: ${theme.spacing(1.5)};
  `,
  panelTitle: css`
    font-size: ${theme.typography.h5.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
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
