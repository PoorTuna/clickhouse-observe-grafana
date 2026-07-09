import React, { ChangeEvent } from 'react';
import { Button, Field, FieldSet, Input, Select } from '@grafana/ui';
import { SelectableValue } from '@grafana/data';
import { ColumnMapping, OTEL_COLUMN_MAPPING } from '../types';

/** Keys that only affect the Traces page — no effect in the Logs Explorer (see each field's
 * `description` below). Hidden there via `hideTraceFields` so the Logs data-view editor isn't
 * cluttered with mappings it can't use; `traceId` is deliberately NOT in this set since it powers
 * the log→trace jump link, which IS a Logs Explorer feature. */
const TRACE_ONLY_KEYS: ReadonlySet<keyof ColumnMapping> = new Set([
  'spanId',
  'parentSpanId',
  'duration',
  'spanName',
  'statusCode',
  'statusMessage',
  'spanKind',
  'spanAttributes',
]);

// `description` says what mapping the field actually turns on — the field name/label alone
// doesn't communicate that (this was a real source of confusion: none of this requires OTel,
// but the column names below are OTel vocabulary since that's the schema this was adapted from).
export const COL_FIELDS: Array<{
  key: keyof ColumnMapping;
  label: string;
  description: string;
  required?: boolean;
}> = [
  {
    key: 'timestamp',
    label: 'Timestamp column',
    description: 'Enables time-range filtering, sorting, and the volume histogram.',
  },
  {
    key: 'body',
    label: 'Log body / message column',
    description: 'Enables free-text search and the Message column.',
  },
  {
    key: 'severity',
    label: 'Severity / level column',
    description: 'Enables the Level column and severity breakdown in the histogram.',
  },
  {
    key: 'traceId',
    label: 'Trace ID column',
    description: 'Enables the trace-jump link in the log detail drawer (also needs Traces table set).',
  },
  {
    key: 'spanId',
    label: 'Span ID column',
    description: 'Used on the Traces page; no effect in Logs Explorer alone.',
  },
  {
    key: 'parentSpanId',
    label: 'Parent Span ID column',
    description: 'Traces page only — no effect on Logs Explorer.',
  },
  {
    key: 'serviceName',
    label: 'Service name expression (can be Map accessor)',
    description: 'Enables the Service column and service-based filtering.',
  },
  {
    key: 'duration',
    label: 'Duration column (nanoseconds)',
    description: 'Traces page only — no effect on Logs Explorer.',
  },
  {
    key: 'spanName',
    label: 'Span name / operation name column',
    description: 'Traces page only — no effect on Logs Explorer.',
  },
  {
    key: 'statusCode',
    label: 'Span status code column',
    description: 'Traces page only — no effect on Logs Explorer.',
  },
  {
    key: 'statusMessage',
    label: 'Span status message column',
    description: 'Traces page only — shown in the span detail drawer when the span has an error.',
  },
  {
    key: 'spanKind',
    label: 'Span kind column',
    description: 'Traces page only — enables the client/server/internal icon on each waterfall row.',
  },
  {
    key: 'resourceAttributes',
    label: 'Resource Attributes Map column',
    description: 'Adds a "Resource Attributes" section to the log detail drawer and enables autocomplete for its keys.',
  },
  {
    key: 'logAttributes',
    label: 'Log Attributes Map column',
    description: 'Adds a "Log Attributes" section to the log detail drawer and enables autocomplete for its keys.',
  },
  {
    key: 'scopeAttributes',
    label: 'Scope Attributes Map column',
    description: 'Adds a "Scope Attributes" section to the log detail drawer and enables autocomplete for its keys.',
  },
  {
    key: 'spanAttributes',
    label: 'Span Attributes Map column',
    description: 'Adds a "Span Attributes" section to the log detail drawer and enables autocomplete for its keys.',
  },
];

interface ColumnMappingFormProps {
  value: ColumnMapping;
  onChange: (updated: ColumnMapping) => void;
  /** When provided, show apply/clear preset buttons that also touch logsTable/tracesTable. */
  onApplyOtelPreset?: () => void;
  onClearMapping?: () => void;
  /** Available column names for this table, from introspection — when provided, each mapping
   * field renders as a searchable dropdown (still free-typeable via allowCustomValue) instead of
   * a plain text input. Omit to keep the old free-text behavior (e.g. AppConfig, which has no
   * live column list to offer). */
  columnOptions?: Array<SelectableValue<string>>;
  /** Hide the trace-only fields (Span/Parent Span ID, Duration, Span name/status/kind, Span
   * Attributes) — set by callers editing a Logs-only data view, where they have no effect. */
  hideTraceFields?: boolean;
}

export function ColumnMappingForm({
  value,
  onChange,
  onApplyOtelPreset,
  onClearMapping,
  columnOptions,
  hideTraceFields,
}: ColumnMappingFormProps) {
  const setField = (key: keyof ColumnMapping, v: string) => {
    onChange({ ...value, [key]: v });
  };

  const fields = hideTraceFields ? COL_FIELDS.filter((f) => !TRACE_ONLY_KEYS.has(f.key)) : COL_FIELDS;

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

      {fields.map(({ key, label, description, required }) => (
        <Field key={key} label={label} description={description} required={required}>
          {columnOptions ? (
            <Select
              width={40}
              value={value[key] || undefined}
              options={columnOptions}
              onChange={(opt) => setField(key, opt?.value ?? '')}
              placeholder={OTEL_COLUMN_MAPPING[key] ?? '—'}
              allowCustomValue
              onCreateOption={(v) => setField(key, v)}
              isClearable
            />
          ) : (
            <Input
              width={40}
              value={value[key]}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setField(key, e.target.value)}
              placeholder={OTEL_COLUMN_MAPPING[key] ?? '—'}
            />
          )}
        </Field>
      ))}
    </FieldSet>
  );
}
