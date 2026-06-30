import React, { useEffect, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';
import { IntervalMode } from '../../types';
import { estimateBucketCount } from '../VolumeHistogram';

interface Props {
  value: IntervalMode;
  onChange: (mode: IntervalMode) => void;
  timeRange: TimeRange;
}

interface Option {
  mode: IntervalMode;
  label: string;
}

const OPTIONS: Option[] = [
  { mode: 'auto',   label: 'Auto' },
  { mode: 'second', label: 'Second' },
  { mode: 'minute', label: 'Minute' },
  { mode: 'hour',   label: 'Hour' },
  { mode: 'day',    label: 'Day' },
  { mode: 'week',   label: 'Week' },
  { mode: 'month',  label: 'Month' },
  { mode: 'year',   label: 'Year' },
];

const MAX_BARS = 1000;

function triggerLabel(mode: IntervalMode): string {
  const opt = OPTIONS.find((o) => o.mode === mode);
  return `${opt?.label ?? 'Auto'} interval`;
}

export function IntervalPicker({ value, onChange, timeRange }: Props) {
  const styles = useStyles2(getStyles);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  function select(mode: IntervalMode) {
    onChange(mode);
    setOpen(false);
  }

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button className={styles.trigger} onClick={() => setOpen((v) => !v)}>
        <Icon name="clock-nine" size="sm" />
        <span>{triggerLabel(value)}</span>
        <Icon name={open ? 'angle-up' : 'angle-down'} size="sm" />
      </button>

      {open && (
        <div className={styles.dropdown}>
          <div className={styles.menuHeader}>Select time interval</div>
          {OPTIONS.map((opt) => {
            const buckets = opt.mode !== 'auto' ? estimateBucketCount(opt.mode, timeRange) : 0;
            const disabled = opt.mode !== 'auto' && buckets > MAX_BARS;
            const active = opt.mode === value;
            return (
              <button
                key={opt.mode}
                className={`${styles.item} ${active ? styles.itemActive : ''} ${disabled ? styles.itemDisabled : ''}`}
                disabled={disabled}
                onClick={() => !disabled && select(opt.mode)}
                title={disabled ? `Too many buckets (${buckets.toLocaleString()}) for this time range` : undefined}
              >
                <span className={styles.itemCheck}>
                  {active && <Icon name="check" size="sm" />}
                </span>
                <span>{opt.label}</span>
              </button>
            );
          })}
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
    white-space: nowrap;
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  dropdown: css`
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 200px;
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    box-shadow: ${theme.shadows.z2};
    z-index: 200;
    overflow: hidden;
  `,
  menuHeader: css`
    padding: ${theme.spacing(0.75)} ${theme.spacing(1.5)};
    font-size: ${theme.typography.bodySmall.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
    border-bottom: 1px solid ${theme.colors.border.weak};
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
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  itemActive: css`
    color: ${theme.colors.primary.text};
  `,
  itemDisabled: css`
    opacity: 0.4;
    cursor: not-allowed;
    &:hover {
      background: transparent;
    }
  `,
  itemCheck: css`
    width: 16px;
    margin-right: ${theme.spacing(0.5)};
    flex-shrink: 0;
    display: flex;
    align-items: center;
    color: ${theme.colors.primary.text};
  `,
});
