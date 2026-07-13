import React, { ChangeEvent } from 'react';
import { Button, Field, FieldSet, Input, Select, Spinner } from '@grafana/ui';
import { SelectableValue } from '@grafana/data';
import { ColumnMapping, OTEL_COLUMN_MAPPING } from '../types';
import { COL_FIELDS, TRACE_ONLY_KEYS } from '../columnFields';

export { COL_FIELDS, TRACE_ONLY_KEYS };

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
  /** When provided (and AI assist is configured/enabled), show a "Guess with AI" button that
   * asks an LLM to fill this form's fields from the table's real columns. */
  onAiGuess?: () => void;
  /** True while an AI guess request is in flight — disables the button and shows a spinner. */
  aiBusy?: boolean;
}

export function ColumnMappingForm({
  value,
  onChange,
  onApplyOtelPreset,
  onClearMapping,
  columnOptions,
  hideTraceFields,
  onAiGuess,
  aiBusy,
}: ColumnMappingFormProps) {
  const setField = (key: keyof ColumnMapping, v: string) => {
    onChange({ ...value, [key]: v });
  };

  const fields = hideTraceFields ? COL_FIELDS.filter((f) => !TRACE_ONLY_KEYS.has(f.key)) : COL_FIELDS;

  return (
    <FieldSet label="Column Mapping">
      {(onApplyOtelPreset || onClearMapping || onAiGuess) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {onAiGuess && (
            <Button variant="secondary" size="sm" icon={aiBusy ? undefined : 'ai'} onClick={onAiGuess} disabled={aiBusy}>
              {aiBusy ? (
                <>
                  <Spinner inline size="sm" /> Guessing…
                </>
              ) : (
                'Guess with AI'
              )}
            </Button>
          )}
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
