import React, { useEffect, useRef, useState } from 'react';
import { useStyles2, Icon } from '@grafana/ui';
import { TimeRange } from '@grafana/data';
import { IntervalMode } from '../../types';
import { estimateBucketCount } from '../VolumeHistogram';
import { getToolbarButtonStyles } from './_toolbarButton';

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
  const styles = useStyles2(getToolbarButtonStyles);
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
        <span>{triggerLabel(value)}</span>
        <Icon name={open ? 'angle-up' : 'angle-down'} size="md" />
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
