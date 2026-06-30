/**
 * Kibana-style "Create data view" modal.
 * Step 1: choose datasource → database → table.
 * Step 2: map timestamp + body columns, auto-detect OTel, configure name → save.
 */
import React, { ChangeEvent, useContext, useEffect, useState } from 'react';
import { dateTime, TimeRange } from '@grafana/data';
import { getDataSourceSrv } from '@grafana/runtime';
import { Alert, Button, Field, Input, Modal, Select, Spinner } from '@grafana/ui';
import { SelectableValue } from '@grafana/data';
import { DataViewContext } from '../App/App';
import { buildColumnsQuery, buildDatabasesQuery, buildTablesQuery } from '../../sql/introspection';
import { runQueryRows } from '../../data/runQuery';
import { looksLikeOtelSchema, applyOtelPreset } from '../../sql/schema';
import { ColumnMapping, DEFAULT_SOURCE_CONFIG, EMPTY_COLUMN_MAPPING, SourceConfig } from '../../types';
import { ColumnMappingForm } from '../ColumnMappingForm';

interface CreateDataViewModalProps {
  isOpen: boolean;
  onDismiss: () => void;
}

const NO_TIME_VALUE = '__no_time__';
const NO_BODY_VALUE = '__no_body__';

// A minimal valid time range for schema-only introspection queries.
function schemaTimeRange(): TimeRange {
  const now = Date.now();
  return {
    from: dateTime(now - 3600 * 1000),
    to: dateTime(now),
    raw: { from: 'now-1h', to: 'now' },
  };
}

type Step = 'location' | 'columns';

export function CreateDataViewModal({ isOpen, onDismiss }: CreateDataViewModalProps) {
  const { createPersonalView, setActiveViewId } = useContext(DataViewContext);

  // Step tracking
  const [step, setStep] = useState<Step>('location');

  // Step 1 state
  const [dsOptions, setDsOptions] = useState<Array<SelectableValue<string>>>([]);
  const [datasourceUid, setDatasourceUid] = useState('');
  const [dbOptions, setDbOptions] = useState<Array<SelectableValue<string>>>([]);
  const [database, setDatabase] = useState('');
  const [tableOptions, setTableOptions] = useState<Array<SelectableValue<string>>>([]);
  const [logsTable, setLogsTable] = useState('');
  const [loadingDbs, setLoadingDbs] = useState(false);
  const [loadingTables, setLoadingTables] = useState(false);

  // Step 2 state
  const [columnOptions, setColumnOptions] = useState<Array<SelectableValue<string>>>([]);
  const [loadingCols, setLoadingCols] = useState(false);
  const [timestampField, setTimestampField] = useState<string | undefined>(undefined);
  const [bodyField, setBodyField] = useState<string | undefined>(undefined);
  const [mapping, setMapping] = useState<ColumnMapping>({ ...EMPTY_COLUMN_MAPPING });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [otelDetected, setOtelDetected] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Reset on open/close
  useEffect(() => {
    if (isOpen) {
      resetAll();
    }
  }, [isOpen]);

  function resetAll() {
    setStep('location');
    setDatasourceUid('');
    setDatabase('');
    setLogsTable('');
    setDbOptions([]);
    setTableOptions([]);
    setColumnOptions([]);
    setTimestampField(undefined);
    setBodyField(undefined);
    setMapping({ ...EMPTY_COLUMN_MAPPING });
    setShowAdvanced(false);
    setOtelDetected(false);
    setName('');
    setError('');
  }

  // Populate datasource picker on mount
  useEffect(() => {
    try {
      const list = getDataSourceSrv().getList();
      const ch = list.filter((ds) => (ds.type ?? '').toLowerCase().includes('clickhouse'));
      setDsOptions(ch.map((ds) => ({ label: ds.name, value: ds.uid ?? ds.name })));
    } catch {}
  }, []);

  // Fetch databases when datasource selected
  async function onDatasourceChange(uid: string) {
    setDatasourceUid(uid);
    setDatabase('');
    setLogsTable('');
    setDbOptions([]);
    setTableOptions([]);
    if (!uid) {
      return;
    }
    setLoadingDbs(true);
    try {
      const rows = await runQueryRows({
        datasourceUid: uid,
        sql: buildDatabasesQuery(),
        timeRange: schemaTimeRange(),
      });
      const opts = rows.map((r) => {
        const n = String(r['name'] ?? '');
        return { label: n, value: n };
      }).filter((o) => o.value);
      setDbOptions(opts);
    } catch (e) {
      setError(`Failed to load databases: ${(e as Error)?.message ?? e}`);
    } finally {
      setLoadingDbs(false);
    }
  }

  // Fetch tables when database selected
  async function onDatabaseChange(db: string) {
    setDatabase(db);
    setLogsTable('');
    setTableOptions([]);
    if (!db || !datasourceUid) {
      return;
    }
    setLoadingTables(true);
    try {
      const rows = await runQueryRows({
        datasourceUid,
        sql: buildTablesQuery(db),
        timeRange: schemaTimeRange(),
      });
      const opts = rows.map((r) => {
        const n = String(r['name'] ?? '');
        return { label: n, value: n };
      }).filter((o) => o.value);
      setTableOptions(opts);
    } catch (e) {
      setError(`Failed to load tables: ${(e as Error)?.message ?? e}`);
    } finally {
      setLoadingTables(false);
    }
  }

  // Proceed to column config step — fetch columns, auto-detect OTel
  async function goToColumnsStep() {
    if (!datasourceUid || !database || !logsTable) {
      return;
    }
    setError('');
    setLoadingCols(true);
    setStep('columns');
    try {
      const rows = await runQueryRows({
        datasourceUid,
        sql: buildColumnsQuery(database, logsTable),
        timeRange: schemaTimeRange(),
      });
      const cols = rows
        .map((r) => String(r['name'] ?? ''))
        .filter(Boolean);

      // Timestamp picker: suggest Date/DateTime types first, then rest
      const typedRows = rows as Array<Record<string, unknown>>;
      const dateTimeCols = typedRows
        .filter((r) => {
          const t = String(r['type'] ?? '').toLowerCase();
          return t.startsWith('date') || t.startsWith('datetime') || t.includes('uint64');
        })
        .map((r) => String(r['name'] ?? ''));

      const timestampOpts: Array<SelectableValue<string>> = [
        { label: '— No time field', value: NO_TIME_VALUE },
        ...dateTimeCols.map((c) => ({ label: c, value: c, description: 'date/time type' })),
        ...cols.filter((c) => !dateTimeCols.includes(c)).map((c) => ({ label: c, value: c })),
      ];

      setColumnOptions(timestampOpts);

      // Auto-detect OTel schema
      const isOtel = looksLikeOtelSchema(cols);
      setOtelDetected(isOtel);
      if (isOtel) {
        // Build a temporary config to run applyOtelPreset, then grab columns
        const tmp: SourceConfig = {
          ...DEFAULT_SOURCE_CONFIG,
          database,
          logsTable,
          datasourceUid,
        };
        const preset = applyOtelPreset(tmp);
        setMapping({ ...preset.columns });
        setTimestampField(preset.columns.timestamp || NO_TIME_VALUE);
        setBodyField(preset.columns.body || NO_BODY_VALUE);
      } else {
        // Guess: use first Date/DateTime col as timestamp, first String col as body
        const firstDateCol = dateTimeCols[0];
        const firstStringCol = typedRows.find((r) => {
          const t = String(r['type'] ?? '').toLowerCase();
          return t.startsWith('string') || t.startsWith('text') || t.includes('string');
        });
        const guessedBody = firstStringCol ? String(firstStringCol['name'] ?? '') : '';
        setTimestampField(firstDateCol || NO_TIME_VALUE);
        setBodyField(guessedBody || NO_BODY_VALUE);
        setMapping({
          ...EMPTY_COLUMN_MAPPING,
          timestamp: firstDateCol || '',
          body: guessedBody,
        });
      }

      setName(`${database}.${logsTable}`);
    } catch (e) {
      setError(`Failed to load columns: ${(e as Error)?.message ?? e}`);
    } finally {
      setLoadingCols(false);
    }
  }

  function onTimestampChange(v: string) {
    setTimestampField(v);
    setMapping((prev) => ({
      ...prev,
      timestamp: v === NO_TIME_VALUE ? '' : v,
    }));
  }

  function onBodyChange(v: string) {
    setBodyField(v);
    setMapping((prev) => ({
      ...prev,
      body: v === NO_BODY_VALUE ? '' : v,
    }));
  }

  function handleSave() {
    setSaving(true);
    setError('');
    try {
      const view = createPersonalView({
        datasourceUid,
        database,
        logsTable,
        tracesTable: '',
        isOtel: otelDetected,
        columns: mapping,
        name: name.trim() || `${database}.${logsTable}`,
      });
      setActiveViewId(view.id);
      onDismiss();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  // Build body Select options (exclude what's shown in column options, add no-body)
  const bodySelectOptions: Array<SelectableValue<string>> = [
    { label: '— (none)', value: NO_BODY_VALUE },
    ...columnOptions
      .filter((o) => o.value !== NO_TIME_VALUE)
      .map((o) => ({ label: o.label ?? o.value ?? '', value: o.value ?? '' })),
  ];

  const canProceed = Boolean(datasourceUid && database && logsTable);
  const canSave = Boolean(name.trim() && (mapping.timestamp || timestampField === NO_TIME_VALUE));

  return (
    <Modal
      title="Create data view"
      isOpen={isOpen}
      onDismiss={onDismiss}
    >
      {error && (
        <Alert title="Error" severity="error" style={{ marginBottom: 16 }}>
          {error}
        </Alert>
      )}

      {step === 'location' && (
        <>
          <Field label="ClickHouse datasource" required>
            <Select
              width={36}
              value={datasourceUid}
              options={dsOptions}
              onChange={(opt) => onDatasourceChange(opt.value ?? '')}
              placeholder="Select datasource…"
            />
          </Field>

          <Field label="Database" required>
            {loadingDbs ? (
              <Spinner size="sm" />
            ) : (
              <Select
                width={36}
                value={database}
                options={dbOptions}
                onChange={(opt) => onDatabaseChange(opt.value ?? '')}
                placeholder={datasourceUid ? 'Select database…' : 'Select a datasource first'}
                disabled={!datasourceUid}
                allowCustomValue
                onCreateOption={(v) => onDatabaseChange(v)}
              />
            )}
          </Field>

          <Field
            label="Table or view name"
            description="Type a name or pick from the list. ClickHouse VIEWs are also listed."
            required
          >
            {loadingTables ? (
              <Spinner size="sm" />
            ) : (
              <Select
                width={36}
                value={logsTable}
                options={tableOptions}
                onChange={(opt) => setLogsTable(opt.value ?? '')}
                onCreateOption={(v) => setLogsTable(v)}
                allowCustomValue
                placeholder={database ? 'Select or type a table…' : 'Select a database first'}
                disabled={!database}
              />
            )}
          </Field>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <Button variant="secondary" onClick={onDismiss}>Cancel</Button>
            <Button variant="primary" disabled={!canProceed} onClick={goToColumnsStep}>
              Next →
            </Button>
          </div>
        </>
      )}

      {step === 'columns' && (
        <>
          {loadingCols && (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <Spinner size="xl" />
              <div style={{ marginTop: 8, color: 'var(--color-text-secondary)' }}>
                Loading columns…
              </div>
            </div>
          )}

          {!loadingCols && (
            <>
              {otelDetected && (
                <Alert title="OpenTelemetry schema detected" severity="info" style={{ marginBottom: 12 }}>
                  Column mapping pre-filled with OTel defaults. Adjust if needed.
                </Alert>
              )}

              <Field
                label="Timestamp field"
                description='Pick the column that holds the event time, or choose "No time field" for timeless tables.'
                required
              >
                <Select
                  width={36}
                  value={timestampField}
                  options={columnOptions}
                  onChange={(opt) => onTimestampChange(opt.value ?? NO_TIME_VALUE)}
                  placeholder="Select timestamp column…"
                />
              </Field>

              <Field label="Body / message field" description="The primary text content of each log line.">
                <Select
                  width={36}
                  value={bodyField}
                  options={bodySelectOptions}
                  onChange={(opt) => onBodyChange(opt.value ?? NO_BODY_VALUE)}
                  placeholder="Select body column…"
                />
              </Field>

              <div style={{ marginBottom: 12 }}>
                <button
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--color-text-secondary)',
                    fontSize: '0.85em',
                    padding: 0,
                  }}
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  {showAdvanced ? '▾' : '▸'} Advanced column mapping (severity, service, trace, attributes…)
                </button>
              </div>

              {showAdvanced && (
                <ColumnMappingForm
                  value={mapping}
                  onChange={(updated) => {
                    setMapping(updated);
                    setTimestampField(updated.timestamp || NO_TIME_VALUE);
                    setBodyField(updated.body || NO_BODY_VALUE);
                  }}
                />
              )}

              <Field label="Data view name" required>
                <Input
                  width={36}
                  value={name}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                  placeholder={`${database}.${logsTable}`}
                />
              </Field>

              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
                <Button variant="secondary" onClick={() => setStep('location')}>
                  ← Back
                </Button>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button variant="secondary" onClick={onDismiss}>Cancel</Button>
                  <Button
                    variant="primary"
                    disabled={!canSave || saving}
                    onClick={handleSave}
                  >
                    {saving ? 'Saving…' : 'Save data view'}
                  </Button>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
