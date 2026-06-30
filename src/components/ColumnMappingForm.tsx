import React, { ChangeEvent } from 'react';
import { Button, Field, FieldSet, Input } from '@grafana/ui';
import { ColumnMapping, OTEL_COLUMN_MAPPING } from '../types';

export const COL_FIELDS: Array<{ key: keyof ColumnMapping; label: string; required?: boolean }> = [
  { key: 'timestamp', label: 'Timestamp column' },
  { key: 'body', label: 'Log body / message column' },
  { key: 'severity', label: 'Severity / level column' },
  { key: 'traceId', label: 'Trace ID column' },
  { key: 'spanId', label: 'Span ID column' },
  { key: 'parentSpanId', label: 'Parent Span ID column' },
  { key: 'serviceName', label: 'Service name expression (can be Map accessor)' },
  { key: 'duration', label: 'Duration column (nanoseconds)' },
  { key: 'resourceAttributes', label: 'Resource Attributes Map column' },
  { key: 'logAttributes', label: 'Log Attributes Map column' },
  { key: 'scopeAttributes', label: 'Scope Attributes Map column' },
  { key: 'spanAttributes', label: 'Span Attributes Map column' },
];

interface ColumnMappingFormProps {
  value: ColumnMapping;
  onChange: (updated: ColumnMapping) => void;
  /** When provided, show apply/clear preset buttons that also touch logsTable/tracesTable. */
  onApplyOtelPreset?: () => void;
  onClearMapping?: () => void;
}

export function ColumnMappingForm({
  value,
  onChange,
  onApplyOtelPreset,
  onClearMapping,
}: ColumnMappingFormProps) {
  const setField = (key: keyof ColumnMapping, v: string) => {
    onChange({ ...value, [key]: v });
  };

  return (
    <FieldSet label="Column Mapping">
      {(onApplyOtelPreset || onClearMapping) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {onApplyOtelPreset && (
            <Button variant="secondary" size="sm" onClick={onApplyOtelPreset}>
              Apply OTel preset
            </Button>
          )}
          {onClearMapping && (
            <Button variant="destructive" size="sm" fill="text" onClick={onClearMapping}>
              Clear all
            </Button>
          )}
          <span style={{ color: 'var(--color-text-secondary)', fontSize: '0.8em' }}>
            OTel preset fills the standard OpenTelemetry schema column names.
            Override individual fields below for custom schemas.
          </span>
        </div>
      )}

      {COL_FIELDS.map(({ key, label, required }) => (
        <Field key={key} label={label} required={required}>
          <Input
            width={40}
            value={value[key]}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setField(key, e.target.value)}
            placeholder={OTEL_COLUMN_MAPPING[key] ?? '—'}
          />
        </Field>
      ))}
    </FieldSet>
  );
}
