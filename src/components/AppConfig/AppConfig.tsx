/**
 * Config page: choose a ClickHouse datasource, set DB/table names,
 * configure column mapping, and apply the OTel preset.
 */

import React, { ChangeEvent, useCallback, useState } from 'react';
import { lastValueFrom } from 'rxjs';
import { css } from '@emotion/css';
import { AppPluginMeta, GrafanaTheme2, PluginConfigPageProps, PluginMeta } from '@grafana/data';
import { getBackendSrv, getDataSourceSrv } from '@grafana/runtime';
import {
  Button,
  Field,
  FieldSet,
  Input,
  InlineSwitch,
  Select,
  useStyles2,
  Alert,
} from '@grafana/ui';
import { applyOtelPreset } from '../../sql/schema';
import {
  AppJsonData,
  ColumnMapping,
  DEFAULT_SOURCE_CONFIG,
  EMPTY_COLUMN_MAPPING,
  OTEL_COLUMN_MAPPING,
  SourceConfig,
} from '../../types';

export interface AppConfigProps extends PluginConfigPageProps<AppPluginMeta<AppJsonData>> {}

const COL_FIELDS: Array<{ key: keyof ColumnMapping; label: string; required?: boolean }> = [
  { key: 'timestamp', label: 'Timestamp column', required: true },
  { key: 'body', label: 'Log body / message column', required: true },
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

const AppConfig = ({ plugin }: AppConfigProps) => {
  const styles = useStyles2(getStyles);
  const { enabled, pinned, jsonData } = plugin.meta;

  const [config, setConfig] = useState<SourceConfig>(
    jsonData?.sourceConfig ?? DEFAULT_SOURCE_CONFIG
  );
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');

  // Datasource picker options (all datasources with type containing 'clickhouse')
  const [dsOptions, setDsOptions] = useState<Array<{ label: string; value: string }>>([]);
  React.useEffect(() => {
    try {
      const list = getDataSourceSrv().getList();
      const ch = list.filter((ds) => (ds.type ?? '').toLowerCase().includes('clickhouse'));
      setDsOptions(ch.map((ds) => ({ label: ds.name, value: ds.uid ?? ds.name })));
    } catch {}
  }, []);

  const setColumnField = (key: keyof ColumnMapping, value: string) => {
    setConfig((prev) => ({
      ...prev,
      columns: { ...prev.columns, [key]: value },
    }));
  };

  const applyOtel = () => {
    setConfig((prev) => applyOtelPreset(prev));
  };

  const clearMapping = () => {
    setConfig((prev) => ({
      ...prev,
      isOtel: false,
      columns: { ...EMPTY_COLUMN_MAPPING },
    }));
  };

  const onSave = async () => {
    setSaveStatus('saving');
    setSaveError('');
    try {
      await updatePlugin(plugin.meta.id, {
        enabled,
        pinned,
        jsonData: { sourceConfig: config },
      });
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
      window.location.reload();
    } catch (err) {
      setSaveError(String((err as Error)?.message ?? err));
      setSaveStatus('error');
    }
  };

  return (
    <div className={styles.page}>
      <FieldSet label="ClickHouse Datasource">
        <Field
          label="Datasource"
          description="Select the installed ClickHouse datasource that this app will query through."
        >
          <Select
            width={40}
            value={config.datasourceUid}
            options={dsOptions}
            onChange={(opt) => setConfig((prev) => ({ ...prev, datasourceUid: opt.value ?? '' }))}
            placeholder="Select ClickHouse datasource…"
          />
        </Field>

        <Field label="Database" description="Default ClickHouse database name.">
          <Input
            width={30}
            value={config.database}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setConfig((prev) => ({ ...prev, database: e.target.value.trim() }))
            }
            placeholder="default"
          />
        </Field>

        <Field label="Logs table">
          <Input
            width={30}
            value={config.logsTable}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setConfig((prev) => ({ ...prev, logsTable: e.target.value.trim() }))
            }
            placeholder="otel_logs"
          />
        </Field>

        <Field label="Traces table">
          <Input
            width={30}
            value={config.tracesTable}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setConfig((prev) => ({ ...prev, tracesTable: e.target.value.trim() }))
            }
            placeholder="otel_traces"
          />
        </Field>
      </FieldSet>

      <FieldSet label="Column Mapping">
        <div className={styles.presetRow}>
          <Button variant="secondary" size="sm" onClick={applyOtel}>
            Apply OTel preset
          </Button>
          <Button variant="destructive" size="sm" fill="text" onClick={clearMapping}>
            Clear all
          </Button>
          <span className={styles.presetHint}>
            OTel preset fills the standard OpenTelemetry schema column names.
            Override individual fields below for custom schemas.
          </span>
        </div>

        {COL_FIELDS.map(({ key, label, required }) => (
          <Field key={key} label={label} required={required}>
            <Input
              width={40}
              value={config.columns[key]}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setColumnField(key, e.target.value)
              }
              placeholder={OTEL_COLUMN_MAPPING[key] ?? '—'}
            />
          </Field>
        ))}
      </FieldSet>

      {saveStatus === 'error' && (
        <Alert title="Save failed" severity="error">
          {saveError}
        </Alert>
      )}
      {saveStatus === 'saved' && (
        <Alert title="Configuration saved" severity="success">
          Reloading…
        </Alert>
      )}

      <div className={styles.footer}>
        <Button onClick={onSave} disabled={saveStatus === 'saving'} icon="save">
          {saveStatus === 'saving' ? 'Saving…' : 'Save configuration'}
        </Button>
      </div>
    </div>
  );
};

export default AppConfig;

const getStyles = (theme: GrafanaTheme2) => ({
  page: css`
    max-width: 700px;
    padding: ${theme.spacing(2)};
  `,
  presetRow: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    margin-bottom: ${theme.spacing(2)};
    flex-wrap: wrap;
  `,
  presetHint: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  footer: css`
    margin-top: ${theme.spacing(3)};
    padding-top: ${theme.spacing(2)};
    border-top: 1px solid ${theme.colors.border.weak};
  `,
});

async function updatePlugin(pluginId: string, data: Partial<PluginMeta<AppJsonData>>) {
  const response = getBackendSrv().fetch({
    url: `/api/plugins/${pluginId}/settings`,
    method: 'POST',
    data,
  });
  return lastValueFrom(response);
}
