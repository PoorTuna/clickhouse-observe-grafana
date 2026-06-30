import React, { useContext, useEffect, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';
import { BreakdownSel } from '../../types';
import { useFields } from '../FieldsContext';
import { SourceConfigContext } from '../App/App';

interface Props {
  value: BreakdownSel;
  onChange: (sel: BreakdownSel) => void;
  /** Whether the active data view has a severity column — shows the Severity entry. */
  hasSeverity: boolean;
}

function triggerLabel(sel: BreakdownSel): string {
  if (sel.kind === 'none') {
    return 'No breakdown';
  }
  if (sel.kind === 'severity') {
    return 'Severity';
  }
  return sel.field.displayName;
}

export function BreakdownPicker({ value, onChange, hasSeverity }: Props) {
  const styles = useStyles2(getStyles);
  const { fields, loading } = useFields();
  const config = useContext(SourceConfigContext);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  // Severity is only real when the mapped column actually exists in the table schema.
  const severityExists =
    Boolean(config.columns.severity) &&
    fields.some(
      (f) =>
        f.source === 'column' &&
        (f.sqlExpr === config.columns.severity || f.name === config.columns.severity)
    );

  // If fields have loaded and severity doesn't exist but is currently selected, fall back.
  useEffect(() => {
    if (!loading && !severityExists && value.kind === 'severity') {
      onChange({ kind: 'none' });
    }
  }, [loading, severityExists, value.kind, onChange]);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const visibleFields = fields.filter((f) =>
    f.displayName.toLowerCase().includes(search.toLowerCase()) ||
    f.name.toLowerCase().includes(search.toLowerCase())
  );

  function select(sel: BreakdownSel) {
    onChange(sel);
    setOpen(false);
    setSearch('');
  }

  const activeFieldId = value.kind === 'field' ? value.field.id : null;

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button className={styles.trigger} onClick={() => setOpen((v) => !v)}>
        <Icon name="chart-bar" size="sm" />
        <span className={styles.triggerLabel}>{triggerLabel(value)}</span>
        <Icon name={open ? 'angle-up' : 'angle-down'} size="sm" />
      </button>

      {open && (
        <div className={styles.dropdown}>
          <div className={styles.searchRow}>
            <input
              ref={inputRef}
              className={styles.searchInput}
              placeholder="Search fields…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className={styles.list}>
            {/* No breakdown */}
            <button
              className={`${styles.item} ${value.kind === 'none' ? styles.itemActive : ''}`}
              onClick={() => select({ kind: 'none' })}
            >
              <span className={styles.itemCheck}>
                {value.kind === 'none' && <Icon name="check" size="sm" />}
              </span>
              <span>No breakdown</span>
            </button>

            {/* Severity — only when the mapped column actually exists in the real schema */}
            {severityExists && (
              <button
                className={`${styles.item} ${value.kind === 'severity' ? styles.itemActive : ''}`}
                onClick={() => select({ kind: 'severity' })}
              >
                <span className={styles.itemCheck}>
                  {value.kind === 'severity' && <Icon name="check" size="sm" />}
                </span>
                <span>Severity</span>
              </button>
            )}

            {/* Field list */}
            {loading && (
              <div className={styles.hint}>Loading fields…</div>
            )}

            {!loading && visibleFields.length === 0 && search && (
              <div className={styles.hint}>No fields match &quot;{search}&quot;</div>
            )}

            {visibleFields.map((field) => {
              const active = activeFieldId === field.id;
              return (
                <button
                  key={field.id}
                  className={`${styles.item} ${active ? styles.itemActive : ''}`}
                  onClick={() => select({ kind: 'field', field })}
                >
                  <span className={styles.itemCheck}>
                    {active && <Icon name="check" size="sm" />}
                  </span>
                  <span className={styles.fieldName}>{field.displayName}</span>
                  {field.source === 'map' && field.mapColumn && (
                    <span className={styles.fieldSource}>{field.mapColumn}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css`
    position: relative;
    flex-shrink: 0;
  `,
  trigger: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    padding: ${theme.spacing(0.5)} ${theme.spacing(1)};
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    cursor: pointer;
    color: ${theme.colors.text.primary};
    font-size: ${theme.typography.bodySmall.fontSize};
    max-width: 220px;
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  triggerLabel: css`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 160px;
  `,
  dropdown: css`
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    width: 260px;
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    box-shadow: ${theme.shadows.z2};
    z-index: 200;
    display: flex;
    flex-direction: column;
    max-height: 340px;
  `,
  searchRow: css`
    padding: ${theme.spacing(0.75)};
    border-bottom: 1px solid ${theme.colors.border.weak};
    flex-shrink: 0;
  `,
  searchInput: css`
    width: 100%;
    padding: ${theme.spacing(0.5)} ${theme.spacing(1)};
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    color: ${theme.colors.text.primary};
    font-size: ${theme.typography.bodySmall.fontSize};
    outline: none;
    box-sizing: border-box;
    &:focus {
      border-color: ${theme.colors.primary.border};
    }
  `,
  list: css`
    overflow-y: auto;
    flex: 1;
  `,
  hint: css`
    padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
    color: ${theme.colors.text.disabled};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  item: css`
    display: flex;
    align-items: center;
    width: 100%;
    padding: ${theme.spacing(0.75)} ${theme.spacing(1.5)};
    background: transparent;
    border: none;
    cursor: pointer;
    color: ${theme.colors.text.primary};
    font-size: ${theme.typography.bodySmall.fontSize};
    text-align: left;
    gap: ${theme.spacing(0.5)};
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  itemActive: css`
    color: ${theme.colors.primary.text};
  `,
  itemCheck: css`
    width: 16px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    color: ${theme.colors.primary.text};
  `,
  fieldName: css`
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  fieldSource: css`
    font-size: 0.75em;
    color: ${theme.colors.text.disabled};
    flex-shrink: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 80px;
  `,
});
