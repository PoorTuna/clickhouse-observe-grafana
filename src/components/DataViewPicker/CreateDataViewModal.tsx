/**
 * "Create data view" modal.
 * Step 1: choose datasource → database → table.
 * Step 2: map timestamp + body columns, auto-detect OTel, configure name → save.
 */
import React, { ChangeEvent, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { dateTime, GrafanaTheme2, SelectableValue, TimeRange } from '@grafana/data';
import { getDataSourceSrv } from '@grafana/runtime';
import { Alert, Button, Checkbox, Field, Input, Modal, MultiSelect, Select, Spinner, Switch, useStyles2 } from '@grafana/ui';
import { AiConfigContext, DataViewContext } from '../App/App';
import { buildColumnsQuery, buildDatabasesQuery, buildJsonPathsQuery, buildTablesQuery } from '../../sql/introspection';
import { runQueryRows } from '../../data/runQuery';
import { applyOtelPreset } from '../../sql/schema';
import { DEFAULT_QUERY_TIMEOUT_SECONDS } from '../../sql/settings';
import { useFieldDiscovery, runWithConcurrencyLimit } from '../FieldsContext';
import { fieldToColumn } from '../FieldSidebar/FieldSidebar';
import { ColumnMapping, DataView, DEFAULT_SOURCE_CONFIG, EMPTY_COLUMN_MAPPING, SelectedColumn, SourceConfig } from '../../types';
import { ColumnMappingForm } from '../ColumnMappingForm';
import { COL_FIELDS } from '../../columnFields';
import { guessColumnMapping, TableColumn } from '../../ai/columnGuess';
import { expandColumnCandidates, JsonPathsByColumn } from '../../ai/columnCandidates';
import { inferFieldType, parseJsonTypedPaths } from '../../sql/fieldModel';
import { errMsg } from '../../errMsg';

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
  const styles = useStyles2(getStyles);
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
  // including JSON paths like "Payload.user.id" — not just top-level columns. (Map keys aren't
  // discovered up front, so they can't be pinned here; see FieldsContext's phase list.)
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [showPinned, setShowPinned] = useState(false);
  // Advanced query settings — defaults match DEFAULT_SOURCE_CONFIG so a regular user creating a
  // view never has to look at this; it exists for the rare case a personal view points at a
  // multi-replica cluster with unusual latency/consistency needs.
  const [sequentialConsistency, setSequentialConsistency] = useState(true);
  const [queryTimeoutSeconds, setQueryTimeoutSeconds] = useState(DEFAULT_QUERY_TIMEOUT_SECONDS);
  const [extraQuerySettings, setExtraQuerySettings] = useState('');
  const [clusterName, setClusterName] = useState('');
  const [showQuerySettings, setShowQuerySettings] = useState(false);
  // Single outer gate for all three "advanced" sub-disclosures below — a regular user creating a
  // view sees none of column mapping / pinned columns / query settings until they open this once.
  // Each sub-section still collapses independently once inside, so opening one doesn't dump all
  // three onto the screen at once.
  const [showAdvancedSection, setShowAdvancedSection] = useState(false);
  // Stable TimeRange reference for schema-only field discovery below — created once so it doesn't
  // change identity every render (schemaTimeRange() uses Date.now(), which would otherwise churn
  // the discovery hook's coarse time bucket and re-fetch on every keystroke).
  const [pinnedFieldsTimeRange] = useState<TimeRange>(() => schemaTimeRange());
  // Guards the async JSON-path scan in goToColumnsStepFor against a stale response landing after
  // the user has already switched tables — same pattern as FieldsContext's runRef.
  const columnsRunRef = useRef(0);

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
    setSequentialConsistency(true);
    setQueryTimeoutSeconds(DEFAULT_QUERY_TIMEOUT_SECONDS);
    setExtraQuerySettings('');
    setShowQuerySettings(false);
    setShowAdvancedSection(false);
  }, []);

  // Field discovery for the "Pinned columns" picker — same hook FieldSidebar/LogsExplorer use,
  // so a pinned selection is discovered exactly like a manually-added sidebar field (including
  // JSON-path leaves; Map keys stay on-demand). Early-returns internally when datasourceUid is empty, so this
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    resetAll();
    if (editingView) {
      setDatasourceUid(editingView.datasourceUid);
      setDatabase(editingView.database);
      setLogsTable(editingView.logsTable);
      setMapping({ ...editingView.columns });
      setTimestampField(editingView.columns.timestamp || NO_TIME_VALUE);
      setBodyField(editingView.columns.body || NO_BODY_VALUE);
      setApplyOtel(editingView.isOtel);
      setName(editingView.name);
      setPinnedIds((editingView.pinnedColumns ?? []).map((col) => col.id));
      setSequentialConsistency(editingView.sequentialConsistency ?? true);
      setQueryTimeoutSeconds(editingView.queryTimeoutSeconds ?? DEFAULT_QUERY_TIMEOUT_SECONDS);
      setExtraQuerySettings(editingView.extraQuerySettings ?? '');
      setClusterName(editingView.clusterName ?? '');
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
        op: 'wizardDatabases',
      });
      const opts = rows.map((r) => {
        const n = String(r['name'] ?? '');
        return { label: n, value: n };
      }).filter((o) => o.value);
      setDbOptions(opts);
    } catch (e) {
      setError(`Failed to load databases: ${errMsg(e)}`);
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
        op: 'wizardTables',
      });
      const opts = rows.map((r) => {
        const n = String(r['name'] ?? '');
        return { label: n, value: n };
      }).filter((o) => o.value);
      setTableOptions(opts);
    } catch (e) {
      setError(`Failed to load tables: ${errMsg(e)}`);
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
    const runId = ++columnsRunRef.current;
    try {
      const rows = await runQueryRows({
        datasourceUid: uid,
        sql: buildColumnsQuery({ ...DEFAULT_SOURCE_CONFIG, datasourceUid: uid, database: db }, table),
        timeRange: schemaTimeRange(),
        op: 'wizardColumns',
      });
      const typedRows = rows as Array<Record<string, unknown>>;
      const rawCols: TableColumn[] = typedRows
        .map((r) => ({ name: String(r['name'] ?? ''), type: String(r['type'] ?? '') }))
        .filter((c) => c.name);

      // Tuple expansion is a synchronous type-string parse (no query) — apply immediately so the
      // step renders with tuple leaves (e.g. "trace.id") already in place instead of the whole
      // Tuple container column. JSON leaves fill in a moment later once the scan below resolves.
      applyCandidates(expandColumnCandidates(rawCols));

      if (resetMapping) {
        // No auto-inference — leave mapping blank. User maps columns by hand or ticks the OTel checkbox.
        setApplyOtel(false);
        setMapping({ ...EMPTY_COLUMN_MAPPING });
        setTimestampField(undefined);
        setBodyField(undefined);
        setName(`${db}.${table}`);
      }

      // JSON path discovery — non-blocking: fires after the step has already rendered with the
      // tuple-expanded (but still JSON-container) candidate list, and doesn't hold up loadingCols.
      // The query itself is answered from part metadata (see buildJsonPathsQuery); worst case on an
      // older server that lacks that optimization is the shared query timeout, not a modal freeze.
      const jsonCols = rawCols.filter((c) => inferFieldType(c.type) === 'json').map((c) => c.name);
      if (jsonCols.length > 0) {
        const scanCfg: SourceConfig = {
          ...DEFAULT_SOURCE_CONFIG,
          datasourceUid: uid,
          database: db,
          logsTable: table,
        };
        // Types come from each column's own declared JSON(...) paths, not from the query — the
        // typed variant of distinctJSONPaths isn't optimized, so asking ClickHouse for them would
        // cost a full column scan. Dynamic paths stay untyped ('').
        const rawTypeByCol = new Map(rawCols.map((c) => [c.name, c.type]));
        runWithConcurrencyLimit(jsonCols, 4, async (jsonCol) => {
          try {
            const pathRows = await runQueryRows({
              datasourceUid: uid,
              sql: buildJsonPathsQuery(scanCfg, jsonCol, { table }),
              timeRange: schemaTimeRange(),
              op: 'wizardJsonPaths',
            });
            const cell = pathRows.length > 0 ? String(pathRows[0]['paths'] ?? '') : '';
            const discovered = cell ? JSON.parse(cell) : [];
            const declaredTypes = new Map(
              parseJsonTypedPaths(rawTypeByCol.get(jsonCol) ?? '').map((p) => [p.path, p.type])
            );
            const paths = (Array.isArray(discovered) ? discovered : [])
              .map((p) => String(p))
              .filter((path) => path.length > 0)
              .map((path) => ({ path, chType: declaredTypes.get(path) ?? '' }));
            return { jsonCol, paths };
          } catch {
            return { jsonCol, paths: [] as Array<{ path: string; chType: string }> };
          }
        })
          .then((perColPaths) => {
            if (columnsRunRef.current !== runId) {
              return; // table switched away before the scan finished — drop the stale result
            }
            const jsonPaths: JsonPathsByColumn = {};
            for (const { jsonCol, paths } of perColPaths) {
              jsonPaths[jsonCol] = paths;
            }
            applyCandidates(expandColumnCandidates(rawCols, jsonPaths));
          })
          .catch(() => {
            // Best-effort — JSON containers simply stay unexpanded on total failure.
          });
      }
    } catch (e) {
      setError(`Failed to load columns: ${errMsg(e)}`);
    } finally {
      setLoadingCols(false);
    }
  }

  // Applies an (expanded) candidate list to tableColumns + both derived option lists — shared by
  // the initial tuple-only pass and the later JSON-path-filled pass in goToColumnsStepFor.
  function applyCandidates(candidates: TableColumn[]) {
    setTableColumns(candidates);

    const dateTimeCols = candidates.filter((c) => isTimeColumnType(c.type)).map((c) => c.name);
    const timestampOpts: Array<SelectableValue<string>> = [
      { label: '— No time field', value: NO_TIME_VALUE },
      ...dateTimeCols.map((c) => ({ label: c, value: c, description: 'date/time type' })),
    ];
    setColumnOptions(timestampOpts);
    setAllColumnOptions(candidates.map((c) => ({ label: c.name, value: c.name })));
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

  // Single "Guess with AI" entry point — guesses every COL_FIELDS key (timestamp, body,
  // severity, traceId, serviceName, spanAttributes) in one shot, so the button visible in the
  // basic step is never weaker than the one that used to be hidden inside Advanced.
  async function runAiGuess() {
    if (!aiCfg || aiBusy || tableColumns.length === 0) {
      return;
    }
    setAiBusy(true);
    setError('');
    try {
      const targets = COL_FIELDS.map((f) => f.key);
      const guessed = await guessColumnMapping(aiCfg, { table: logsTable, columns: tableColumns, targets });
      setMapping((prev) => {
        const next = { ...prev, ...guessed };
        setTimestampField(next.timestamp || NO_TIME_VALUE);
        setBodyField(next.body || NO_BODY_VALUE);
        return next;
      });
    } catch (e) {
      setError(`AI guess failed: ${errMsg(e)}`);
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
        sequentialConsistency,
        queryTimeoutSeconds:
          queryTimeoutSeconds !== DEFAULT_QUERY_TIMEOUT_SECONDS ? queryTimeoutSeconds : undefined,
        extraQuerySettings: extraQuerySettings.trim() || undefined,
        clusterName: clusterName.trim() || undefined,
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
      setError(errMsg(e));
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
        <Alert title="Error" severity="error" className={styles.alert}>
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

          <div className={styles.footerRowEnd}>
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
        <div className={styles.columnsStep}>
          {loadingCols && (
            <div className={styles.loadingCentered}>
              <Spinner size="xl" />
              <div className={styles.loadingLabel}>
                Loading columns…
              </div>
            </div>
          )}

          {!loadingCols && (
            <>
              <div className={styles.blockSpacingLg}>
                <Checkbox
                  label="This table uses the OpenTelemetry schema — apply preset"
                  description="Pre-fills all column mappings with standard OTel column names (Timestamp, Body, SeverityText, …)."
                  value={applyOtel}
                  onChange={(e) => onApplyOtelChange(e.currentTarget.checked)}
                />
              </div>

              {aiOn && (
                <div className={styles.blockSpacing}>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={aiBusy ? undefined : 'ai'}
                    disabled={aiBusy}
                    onClick={() => runAiGuess()}
                  >
                    {aiBusy ? (
                      <>
                        <Spinner inline size="sm" /> Guessing…
                      </>
                    ) : (
                      'Guess with AI'
                    )}
                  </Button>
                  <span className={styles.aiGuessHint}>
                    Fills timestamp, body, severity, trace ID, service name, and span attributes — including the fields under Advanced.
                  </span>
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

              <div className={styles.blockSpacing}>
                <button
                  className={styles.disclosureBtn}
                  onClick={() => setShowAdvancedSection((v) => !v)}
                >
                  {showAdvancedSection ? '▾' : '▸'} Advanced
                </button>
              </div>

              {showAdvancedSection && (
                <div className={styles.advancedGroup}>
                  <div className={styles.blockSpacing}>
                    <button
                      className={styles.disclosureBtn}
                      onClick={() => setShowAdvanced((v) => !v)}
                    >
                      {showAdvanced ? '▾' : '▸'} Column mapping (severity, service, trace, attributes…)
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
                    />
                  )}

                  <div className={styles.blockSpacing}>
                    <button
                      className={styles.disclosureBtn}
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

                  <div className={styles.blockSpacing}>
                    <button
                      className={styles.disclosureBtn}
                      onClick={() => setShowQuerySettings((v) => !v)}
                    >
                      {showQuerySettings ? '▾' : '▸'} Query settings
                    </button>
                  </div>

                  {showQuerySettings && (
                    <>
                      <Field
                        label="Sequential consistency"
                        description="Makes each replica catch up before answering, so a load-balanced cluster can't return stale rows. Costs one Keeper round-trip per query. Turn off for single-node."
                      >
                        <Switch
                          value={sequentialConsistency}
                          onChange={(e) => setSequentialConsistency(e.currentTarget.checked)}
                        />
                      </Field>

                      <Field
                        label="Query timeout (seconds)"
                        description={`Every query for this view is capped at this many seconds (ClickHouse max_execution_time, throw-on-timeout). Defaults to ${DEFAULT_QUERY_TIMEOUT_SECONDS}s — deliberately below a typical reverse-proxy's own hard timeout (e.g. a 30s OpenShift Route) so ClickHouse's own failure wins the race instead of the proxy killing the connection and Grafana surfacing an opaque 502/504.`}
                      >
                        <Input
                          width={15}
                          type="number"
                          value={queryTimeoutSeconds}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => {
                            const n = Number(e.target.value);
                            setQueryTimeoutSeconds(Number.isFinite(n) && n > 0 ? n : DEFAULT_QUERY_TIMEOUT_SECONDS);
                          }}
                        />
                      </Field>

                      <Field
                        label="Additional query SETTINGS"
                        description="Appended to every query for this view. Comma-separated. Overrides the defaults above (including the query timeout above), except timeout_overflow_mode / read_overflow_mode / result_overflow_mode / group_by_overflow_mode, which every query builder in this plugin deliberately pins to a loud-failure mode — a 'break'/'any' override there is ignored rather than silently truncating results."
                      >
                        <Input
                          width={50}
                          value={extraQuerySettings}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => setExtraQuerySettings(e.target.value)}
                          placeholder="max_replica_delay_for_distributed_queries = 30"
                        />
                      </Field>

                      <Field
                        label="Cluster name (for diagnostics)"
                        description="Only used by the Inspect drawer's optional server-side enrichment tier (off by default). When set, its system.query_log lookup reads via clusterAllReplicas(<name>, system.query_log) so it finds a query's stats regardless of which replica answered. Leave blank for a single node."
                      >
                        <Input
                          width={30}
                          value={clusterName}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => setClusterName(e.target.value.trim())}
                          placeholder="my_cluster"
                        />
                      </Field>
                    </>
                  )}
                </div>
              )}

              <Field label="Data view name" required>
                <Input
                  width={36}
                  value={name}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                  placeholder={`${database}.${logsTable}`}
                />
              </Field>

              <div className={styles.footerRowBetween}>
                <Button variant="secondary" onClick={() => setStep('location')}>
                  ← Back
                </Button>
                <div className={styles.footerRowGroup}>
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

const getStyles = (theme: GrafanaTheme2) => ({
  alert: css`
    margin-bottom: ${theme.spacing(2)};
  `,
  advancedGroup: css`
    padding-left: ${theme.spacing(2)};
    border-left: 2px solid ${theme.colors.border.weak};
    margin-bottom: ${theme.spacing(1.5)};
  `,
  footerRowEnd: css`
    display: flex;
    justify-content: flex-end;
    gap: ${theme.spacing(1)};
    margin-top: ${theme.spacing(2)};
  `,
  footerRowBetween: css`
    display: flex;
    justify-content: space-between;
    margin-top: ${theme.spacing(2)};
  `,
  footerRowGroup: css`
    display: flex;
    gap: ${theme.spacing(1)};
  `,
  // Fixed min-height across the loading→loaded swap: <Modal> auto-sizes to its content, so
  // without this the small spinner block made the modal shrink, then jump/resize again the
  // instant the full form replaced it. Matching the loaded form's rough height up front keeps
  // the modal's bounding box stable through the transition.
  columnsStep: css`
    min-height: 420px;
  `,
  loadingCentered: css`
    min-height: 420px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  `,
  loadingLabel: css`
    margin-top: ${theme.spacing(1)};
    color: ${theme.colors.text.secondary};
  `,
  blockSpacing: css`
    margin-bottom: ${theme.spacing(1.5)};
  `,
  aiGuessHint: css`
    margin-left: ${theme.spacing(1)};
    color: ${theme.colors.text.secondary};
    font-size: 0.8em;
  `,
  blockSpacingLg: css`
    margin-bottom: ${theme.spacing(2)};
  `,
  disclosureBtn: css`
    background: transparent;
    border: none;
    cursor: pointer;
    color: ${theme.colors.text.secondary};
    font-size: 0.85em;
    padding: 0;
    &:hover {
      color: ${theme.colors.text.primary};
    }
  `,
});
