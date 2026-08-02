/**
 * "Create data view" modal.
 * Step 1: choose datasource → database → table.
 * Step 2: map timestamp + body columns, auto-detect OTel, configure name → save.
 */
import React, { ChangeEvent, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { dateTime, SelectableValue, TimeRange } from '@grafana/data';
import { getDataSourceSrv } from '@grafana/runtime';
import { Alert, Button, Checkbox, Field, Input, Modal, MultiSelect, Select, Spinner } from '@grafana/ui';
import { AiConfigContext, DataViewContext } from '../App/App';
import { buildColumnsQuery, buildDatabasesQuery, buildTablesQuery } from '../../sql/introspection';
import { runQueryRows } from '../../data/runQuery';
import { applyOtelPreset } from '../../sql/schema';
import { useFieldDiscovery } from '../FieldsContext';
import { fieldToColumn } from '../FieldSidebar/FieldSidebar';
import { ColumnMapping, DataView, DEFAULT_SOURCE_CONFIG, EMPTY_COLUMN_MAPPING, SelectedColumn, SourceConfig } from '../../types';
import { ColumnMappingForm } from '../ColumnMappingForm';
import { COL_FIELDS } from '../../columnFields';
import { guessColumnMapping, TableColumn } from '../../ai/columnGuess';

interface CreateDataViewModalProps {
  isOpen: boolean;
  onDismiss: () => void;
  /** When set, the modal edits this personal view in place (jumps straight to the column-mapping
   *  step, pre-filled) instead of creating a new one. Only ever passed a personal view — shared
   *  views are admin-managed via plugin config, matching the existing delete-personal-view-only
   *  pattern in DataViewPicker. */
  editingView?: DataView;
}

const NO_TIME_VALUE = '__no_time__';
const NO_BODY_VALUE = '__no_body__';

// Matches ClickHouse Date, Date32, DateTime, DateTime64(...), unwrapping
// Nullable(...) / LowCardinality(...) wrappers first.
function isTimeColumnType(rawType: string): boolean {
  const t = rawType.toLowerCase().replace(/^(nullable|lowcardinality)\(([^)]+)\)$/, '$2');
  return /^date(32|time(64)?)?\b/.test(t);
}

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

export function CreateDataViewModal({ isOpen, onDismiss, editingView }: CreateDataViewModalProps) {
  const { createPersonalView, updatePersonalView, setActiveViewId } = useContext(DataViewContext);
  const aiCfg = useContext(AiConfigContext);
  const aiOn = Boolean(aiCfg?.enabled && aiCfg?.baseUrl && aiCfg?.model);

  // Step tracking
  const [step, setStep] = useState<Step>('location');

  // Step 1 state. Datasource list is read synchronously from getDataSourceSrv() (no
  // fetch), so it's lazy-initialized here instead of populated from an effect.
  const [dsOptions] = useState<Array<SelectableValue<string>>>(() => {
    try {
      const list = getDataSourceSrv().getList();
      const ch = list.filter((ds) => (ds.type ?? '').toLowerCase().includes('clickhouse'));
      return ch.map((ds) => ({ label: ds.name, value: ds.uid ?? ds.name }));
    } catch {
      return [];
    }
  });
  const [datasourceUid, setDatasourceUid] = useState('');
  const [dbOptions, setDbOptions] = useState<Array<SelectableValue<string>>>([]);
  const [database, setDatabase] = useState('');
  const [tableOptions, setTableOptions] = useState<Array<SelectableValue<string>>>([]);
  const [logsTable, setLogsTable] = useState('');
  const [loadingDbs, setLoadingDbs] = useState(false);
  const [loadingTables, setLoadingTables] = useState(false);

  // Step 2 state
  const [columnOptions, setColumnOptions] = useState<Array<SelectableValue<string>>>([]);
  const [allColumnOptions, setAllColumnOptions] = useState<Array<SelectableValue<string>>>([]);
  // Raw name+type pairs for the current table — the input the AI guesser needs (allColumnOptions
  // only carries names). Populated alongside columnOptions/allColumnOptions in goToColumnsStepFor.
  const [tableColumns, setTableColumns] = useState<TableColumn[]>([]);
  const [loadingCols, setLoadingCols] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [timestampField, setTimestampField] = useState<string | undefined>(undefined);
  const [bodyField, setBodyField] = useState<string | undefined>(undefined);
  const [mapping, setMapping] = useState<ColumnMapping>({ ...EMPTY_COLUMN_MAPPING });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [applyOtel, setApplyOtel] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // "Pinned columns" — extra non-core columns this view loads with the grid by default (see
  // SourceConfig.pinnedColumns). Stores selected FieldModel ids; order = selection order =
  // display order. Field discovery below (same hook the sidebar/drawer use) supplies the options,
  // including Map/JSON leaf paths like "LogAttributes.http.method" — not just top-level columns.
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [showPinned, setShowPinned] = useState(false);
  // Stable TimeRange reference for schema-only field discovery below — created once so it doesn't
  // change identity every render (schemaTimeRange() uses Date.now(), which would otherwise churn
  // the discovery hook's coarse time bucket and re-fetch on every keystroke).
  const [pinnedFieldsTimeRange] = useState<TimeRange>(() => schemaTimeRange());

  const resetAll = useCallback(() => {
    setStep('location');
    setDatasourceUid('');
    setDatabase('');
    setLogsTable('');
    setDbOptions([]);
    setTableOptions([]);
    setColumnOptions([]);
    setTableColumns([]);
    setTimestampField(undefined);
    setBodyField(undefined);
    setMapping({ ...EMPTY_COLUMN_MAPPING });
    setShowAdvanced(false);
    setApplyOtel(false);
    setName('');
    setError('');
    setPinnedIds([]);
    setShowPinned(false);
  }, []);

  // Field discovery for the "Pinned columns" picker — same hook FieldSidebar/LogsExplorer use,
  // so a pinned selection is discovered exactly like a manually-added sidebar field (including
  // Map-key and JSON-path leaves). Early-returns internally when datasourceUid is empty, so this
  // is a no-op until step 1 is complete.
  const pinnableFieldsConfig: SourceConfig = useMemo(
    () => ({ ...DEFAULT_SOURCE_CONFIG, datasourceUid, database, logsTable, columns: mapping }),
    [datasourceUid, database, logsTable, mapping]
  );
  const { fields: pinnableFields } = useFieldDiscovery(pinnableFieldsConfig, pinnedFieldsTimeRange);
  // Core columns (Time/Level/Service/Message) are always shown and never removable — offering them
  // here would be confusing (picking them would do nothing, per defaultColumns()'s de-dupe).
  const coreExprs = useMemo(
    () => new Set([mapping.timestamp, mapping.body, mapping.severity, mapping.serviceName].filter(Boolean)),
    [mapping.timestamp, mapping.body, mapping.severity, mapping.serviceName]
  );
  const pinnableOptions: Array<SelectableValue<string>> = useMemo(
    () =>
      pinnableFields
        .filter((f) => !coreExprs.has(f.sqlExpr))
        .map((f) => ({ label: f.displayName, value: f.id })),
    [pinnableFields, coreExprs]
  );

  // Reset on open/close. isOpen is an external (parent-controlled) signal, so re-deriving
  // the modal's internal state from it here is the intended sync, not a render-time update.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    resetAll();
    if (editingView) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDatasourceUid(editingView.datasourceUid);
      setDatabase(editingView.database);
      setLogsTable(editingView.logsTable);
      setMapping({ ...editingView.columns });
      setTimestampField(editingView.columns.timestamp || NO_TIME_VALUE);
      setBodyField(editingView.columns.body || NO_BODY_VALUE);
      setApplyOtel(editingView.isOtel);
      setName(editingView.name);
      setPinnedIds((editingView.pinnedColumns ?? []).map((col) => col.id));
      goToColumnsStepFor(editingView.datasourceUid, editingView.database, editingView.logsTable, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, editingView, resetAll]);

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

  // Proceed to column config step — fetch columns for the given location. Shared by the
  // "Next →" button (fresh view, resets mapping) and the edit-view effect above (pre-fills
  // mapping from the view being edited instead of resetting it) — the only difference is what
  // happens to mapping/name after the columns load, controlled by `resetMapping`.
  async function goToColumnsStepFor(uid: string, db: string, table: string, resetMapping = true) {
    if (!uid || !db || !table) {
      return;
    }
    setError('');
    setLoadingCols(true);
    setStep('columns');
    try {
      const rows = await runQueryRows({
        datasourceUid: uid,
        sql: buildColumnsQuery(db, table),
        timeRange: schemaTimeRange(),
      });
      const typedRows = rows as Array<Record<string, unknown>>;
      const cols = typedRows
        .map((r) => String(r['name'] ?? ''))
        .filter(Boolean);

      setTableColumns(
        typedRows
          .map((r) => ({ name: String(r['name'] ?? ''), type: String(r['type'] ?? '') }))
          .filter((c) => c.name)
      );

      // Timestamp picker: only columns with an actual date/time type.
      const dateTimeCols = typedRows
        .filter((r) => isTimeColumnType(String(r['type'] ?? '')))
        .map((r) => String(r['name'] ?? ''));

      const timestampOpts: Array<SelectableValue<string>> = [
        { label: '— No time field', value: NO_TIME_VALUE },
        ...dateTimeCols.map((c) => ({ label: c, value: c, description: 'date/time type' })),
      ];

      setColumnOptions(timestampOpts);
      setAllColumnOptions(cols.map((c) => ({ label: c, value: c })));

      if (resetMapping) {
        // No auto-inference — leave mapping blank. User maps columns by hand or ticks the OTel checkbox.
        setApplyOtel(false);
        setMapping({ ...EMPTY_COLUMN_MAPPING });
        setTimestampField(undefined);
        setBodyField(undefined);
        setName(`${db}.${table}`);
      }
    } catch (e) {
      setError(`Failed to load columns: ${(e as Error)?.message ?? e}`);
    } finally {
      setLoadingCols(false);
    }
  }

  function goToColumnsStep() {
    return goToColumnsStepFor(datasourceUid, database, logsTable);
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

  // Shared by the basic (timestamp+body) and advanced (full non-trace set) "Guess with AI"
  // buttons — only the target field list and how the result is applied differ.
  async function runAiGuess(targets: Array<keyof ColumnMapping>, applyBasicFields: boolean) {
    if (!aiCfg || aiBusy || tableColumns.length === 0) {
      return;
    }
    setAiBusy(true);
    setError('');
    try {
      const guessed = await guessColumnMapping(aiCfg, { table: logsTable, columns: tableColumns, targets });
      setMapping((prev) => {
        const next = { ...prev, ...guessed };
        if (applyBasicFields) {
          setTimestampField(next.timestamp || NO_TIME_VALUE);
          setBodyField(next.body || NO_BODY_VALUE);
        }
        return next;
      });
    } catch (e) {
      setError(`AI guess failed: ${(e as Error)?.message ?? e}`);
    } finally {
      setAiBusy(false);
    }
  }

  function onApplyOtelChange(checked: boolean) {
    setApplyOtel(checked);
    if (checked) {
      const tmp: SourceConfig = {
        ...DEFAULT_SOURCE_CONFIG,
        datasourceUid,
        database,
        logsTable,
      };
      const preset = applyOtelPreset(tmp);
      setMapping({ ...preset.columns });
      setTimestampField(preset.columns.timestamp || NO_TIME_VALUE);
      setBodyField(preset.columns.body || NO_BODY_VALUE);
    } else {
      setMapping({ ...EMPTY_COLUMN_MAPPING });
      setTimestampField(undefined);
      setBodyField(undefined);
    }
  }

  function handleSave() {
    setSaving(true);
    setError('');
    try {
      // Resolve selected pinned ids back to full SelectedColumn shapes via the same
      // fieldToColumn() builder the sidebar uses — a pinned column is indistinguishable from one
      // added by hand in the grid. `undefined` (not []) when nothing is picked, matching the
      // shape of a view that never configured this. The key must still be *present* on `values`
      // (not omitted) so editing an existing view can clear a previously-saved pinned set —
      // updatePersonalView does a shallow `{...prev, ...updates}` merge, which only overwrites
      // keys that appear in `updates`.
      const pinnedColumns: SelectedColumn[] = pinnedIds
        .map((id) => pinnableFields.find((f) => f.id === id))
        .filter((f): f is NonNullable<typeof f> => Boolean(f))
        .map(fieldToColumn);
      const values = {
        datasourceUid,
        database,
        logsTable,
        isOtel: applyOtel,
        columns: mapping,
        name: name.trim() || `${database}.${logsTable}`,
        pinnedColumns: pinnedColumns.length > 0 ? pinnedColumns : undefined,
      };
      if (editingView) {
        updatePersonalView(editingView.id, values);
        setActiveViewId(editingView.id);
      } else {
        const view = createPersonalView(values);
        setActiveViewId(view.id);
      }
      onDismiss();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  // Build body Select options from all columns (any type may hold the message), add no-body
  const bodySelectOptions: Array<SelectableValue<string>> = [
    { label: '— (none)', value: NO_BODY_VALUE },
    ...allColumnOptions.map((o) => ({ label: o.label ?? o.value ?? '', value: o.value ?? '' })),
  ];

  const canProceed = Boolean(datasourceUid && database && logsTable);
  const canSave = Boolean(name.trim() && (mapping.timestamp || timestampField === NO_TIME_VALUE));

  return (
    <Modal
      title={editingView ? `Edit data view: ${editingView.name}` : 'Create data view'}
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
        // Fixed min-height across the loading→loaded swap: <Modal> auto-sizes to its content, so
        // without this the small spinner block (previously just `padding: 24px 0`) made the modal
        // shrink, then jump/resize again the instant the full form replaced it — the visible
        // flicker reported against this step. Matching the loaded form's rough height up front
        // keeps the modal's bounding box stable through the transition.
        <div style={{ minHeight: 420 }}>
          {loadingCols && (
            <div
              style={{
                minHeight: 420,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Spinner size="xl" />
              <div style={{ marginTop: 8, color: 'var(--color-text-secondary)' }}>
                Loading columns…
              </div>
            </div>
          )}

          {!loadingCols && (
            <>
              <div style={{ marginBottom: 16 }}>
                <Checkbox
                  label="This table uses the OpenTelemetry schema — apply preset"
                  description="Pre-fills all column mappings with standard OTel column names (Timestamp, Body, SeverityText, …)."
                  value={applyOtel}
                  onChange={(e) => onApplyOtelChange(e.currentTarget.checked)}
                />
              </div>

              {aiOn && (
                <div style={{ marginBottom: 12 }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={aiBusy ? undefined : 'ai'}
                    disabled={aiBusy}
                    onClick={() => runAiGuess(['timestamp', 'body'], true)}
                  >
                    {aiBusy ? (
                      <>
                        <Spinner inline size="sm" /> Guessing…
                      </>
                    ) : (
                      'Guess with AI'
                    )}
                  </Button>
                </div>
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
                  columnOptions={allColumnOptions}
                  onAiGuess={
                    aiOn
                      ? () => runAiGuess(COL_FIELDS.map((f) => f.key), true)
                      : undefined
                  }
                  aiBusy={aiBusy}
                />
              )}

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
                  onClick={() => setShowPinned((v) => !v)}
                >
                  {showPinned ? '▾' : '▸'} Pinned columns ({pinnedIds.length} selected)
                </button>
              </div>

              {showPinned && (
                <Field
                  label="Pinned columns"
                  description="Extra columns this view loads with the grid by default, in addition to Time/Level/Service/Message — which are always shown. Reorderable and removable in the grid afterward, just like any manually-added column."
                >
                  <MultiSelect
                    width={36}
                    value={pinnedIds}
                    options={pinnableOptions}
                    onChange={(opts) => setPinnedIds(opts.map((o) => o.value ?? '').filter(Boolean))}
                    placeholder="Select fields to pin…"
                    closeMenuOnSelect={false}
                  />
                </Field>
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
                    {saving ? 'Saving…' : editingView ? 'Save changes' : 'Save data view'}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
