/**
 * Config page: manage shared data views (admin-only).
 * Views are stored in jsonData.dataViews[] and visible to all users of this plugin.
 * Users can also create personal (per-browser) views from the Logs Explorer header.
 */

import React, { ChangeEvent, useState } from 'react';
import { lastValueFrom } from 'rxjs';
import { css } from '@emotion/css';
import { AppPluginMeta, GrafanaTheme2, PluginConfigPageProps, PluginMeta } from '@grafana/data';
import { getBackendSrv, getDataSourceSrv } from '@grafana/runtime';
import { Alert, Button, Field, FieldSet, Input, Select, Switch, useStyles2 } from '@grafana/ui';
import { applyOtelPreset } from '../../sql/schema';
import { errMsg } from '../../errMsg';
import {
  AiProviderConfig,
  AppJsonData,
  DataView,
  DEFAULT_SOURCE_CONFIG,
  EMPTY_COLUMN_MAPPING,
} from '../../types';
import { migrateLegacyConfig } from '../../data/dataViews';
import { ColumnMappingForm } from '../ColumnMappingForm';

export interface AppConfigProps extends PluginConfigPageProps<AppPluginMeta<AppJsonData>> {}

const AppConfig = ({ plugin }: AppConfigProps) => {
  const styles = useStyles2(getStyles);
  const { enabled, pinned, jsonData } = plugin.meta;

  // On first load, migrate legacy sourceConfig → dataViews if needed.
  const [views, setViews] = useState<DataView[]>(() => migrateLegacyConfig(jsonData ?? {}));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');

  const [ai, setAi] = useState<AiProviderConfig>(
    () => jsonData?.ai ?? { enabled: false, baseUrl: '', model: '', token: '' }
  );
  function patchAi(patch: Partial<AiProviderConfig>) {
    setAi((prev) => ({ ...prev, ...patch }));
  }

  // Datasource list is read synchronously from getDataSourceSrv() (no fetch), so it's
  // lazy-initialized here instead of populated from an effect.
  const [dsOptions] = useState<Array<{ label: string; value: string }>>(() => {
    try {
      const list = getDataSourceSrv().getList();
      const ch = list.filter((ds) => (ds.type ?? '').toLowerCase().includes('clickhouse'));
      return ch.map((ds) => ({ label: ds.name, value: ds.uid ?? ds.name }));
    } catch {
      return [];
    }
  });

  function patchView(id: string, patch: Partial<DataView>) {
    setViews((prev) => prev.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  }

  function addView() {
    const newView: DataView = {
      ...DEFAULT_SOURCE_CONFIG,
      id: `shared_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      name: 'New view',
      origin: 'shared',
      createdAt: new Date().toISOString(),
    };
    setViews((prev) => [...prev, newView]);
    setEditingId(newView.id);
  }

  function deleteView(id: string) {
    setViews((prev) => prev.filter((v) => v.id !== id));
    if (editingId === id) {
      setEditingId(null);
    }
  }

  const onSave = async () => {
    setSaveStatus('saving');
    setSaveError('');
    try {
      await updatePlugin(plugin.meta.id, {
        enabled,
        pinned,
        jsonData: { ...jsonData, dataViews: views, ai },
      });
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
      window.location.reload();
    } catch (err) {
      setSaveError(errMsg(err));
      setSaveStatus('error');
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.viewListHeader}>
        <h3 className={styles.sectionTitle}>Shared Data Views</h3>
        <Button variant="secondary" size="sm" icon="plus" onClick={addView}>
          Add view
        </Button>
      </div>

      {views.length === 0 && (
        <div className={styles.empty}>
          No data views configured. Click &ldquo;Add view&rdquo; to create one, or users can create
          personal views from the Logs Explorer header.
        </div>
      )}

      <div className={styles.viewList}>
        {views.map((v) => (
          <div key={v.id} className={`${styles.viewCard} ${editingId === v.id ? styles.viewCardActive : ''}`}>
            <div className={styles.viewCardHeader}>
              <span className={styles.viewCardName}>{v.name || '(unnamed)'}</span>
              <span className={styles.viewCardSub}>{v.database}.{v.logsTable}</span>
              <div className={styles.viewCardActions}>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setEditingId(editingId === v.id ? null : v.id)}
                >
                  {editingId === v.id ? 'Collapse' : 'Edit'}
                </Button>
                <Button size="sm" variant="destructive" fill="text" onClick={() => deleteView(v.id)}>
                  Delete
                </Button>
              </div>
            </div>

            {editingId === v.id && (
              <div className={styles.viewEditor}>
                <Field label="Name">
                  <Input
                    width={30}
                    value={v.name}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      patchView(v.id, { name: e.target.value })
                    }
                    placeholder="My logs view"
                  />
                </Field>

                <Field label="ClickHouse datasource">
                  <Select
                    width={30}
                    value={v.datasourceUid}
                    options={dsOptions}
                    onChange={(opt) => patchView(v.id, { datasourceUid: opt.value ?? '' })}
                    placeholder="Select datasource…"
                  />
                </Field>

                <Field label="Database">
                  <Input
                    width={30}
                    value={v.database}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      patchView(v.id, { database: e.target.value.trim() })
                    }
                    placeholder="default"
                  />
                </Field>

                <Field label="Logs table">
                  <Input
                    width={30}
                    value={v.logsTable}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      patchView(v.id, { logsTable: e.target.value.trim() })
                    }
                    placeholder="otel_logs"
                  />
                </Field>

                <Field
                  label="Sequential consistency"
                  description="Makes each replica catch up before answering, so a load-balanced cluster can't return stale rows. Costs one Keeper round-trip per query. Turn off for single-node."
                >
                  <Switch
                    value={v.sequentialConsistency ?? true}
                    onChange={(e) => patchView(v.id, { sequentialConsistency: e.currentTarget.checked })}
                  />
                </Field>

                <Field
                  label="Additional query SETTINGS"
                  description="Appended to every query for this view. Comma-separated. Overrides the defaults above, except timeout_overflow_mode / read_overflow_mode / result_overflow_mode / group_by_overflow_mode, which every query builder in this plugin deliberately pins to a loud-failure mode — a 'break'/'any' override there is ignored rather than silently truncating results."
                >
                  <Input
                    width={50}
                    value={v.extraQuerySettings ?? ''}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      patchView(v.id, { extraQuerySettings: e.target.value })
                    }
                    placeholder="max_replica_delay_for_distributed_queries = 30"
                  />
                </Field>

                <Field
                  label="Cluster name (for diagnostics)"
                  description="Only used by the Inspect drawer's optional server-side enrichment tier (off by default — see the toggle in the drawer). When set, its system.query_log lookup reads via clusterAllReplicas(<name>, system.query_log) so it finds a query's stats regardless of which replica answered. Leave blank for a single node or a non-distributed setup."
                >
                  <Input
                    width={30}
                    value={v.clusterName ?? ''}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => patchView(v.id, { clusterName: e.target.value.trim() })}
                    placeholder="my_cluster"
                  />
                </Field>

                <ColumnMappingForm
                  value={v.columns}
                  onChange={(updated) => patchView(v.id, { columns: updated })}
                  onApplyOtelPreset={() => {
                    const preset = applyOtelPreset(v);
                    patchView(v.id, {
                      logsTable: preset.logsTable,
                      isOtel: true,
                      columns: preset.columns,
                    });
                  }}
                  onClearMapping={() =>
                    patchView(v.id, { isOtel: false, columns: { ...EMPTY_COLUMN_MAPPING } })
                  }
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <FieldSet label="AI Assistant">
        <div className={styles.empty} style={{ marginBottom: 12 }}>
          Optional &ldquo;Guess with AI&rdquo; assist for column mapping. Points at any OpenAI-compatible
          `/chat/completions` endpoint — hosted or self-hosted (e.g. Ollama). The token below is
          stored in plain settings (not encrypted secret storage) and is readable by any browser
          user of this plugin — fine for local/self-hosted models, not for a sensitive API key.
        </div>
        <Field label="Enable AI column guessing">
          <Switch value={ai.enabled} onChange={(e) => patchAi({ enabled: e.currentTarget.checked })} />
        </Field>
        <Field label="API base URL" description="OpenAI-compatible base URL, e.g. http://localhost:11434/v1">
          <Input
            width={40}
            value={ai.baseUrl}
            onChange={(e: ChangeEvent<HTMLInputElement>) => patchAi({ baseUrl: e.target.value.trim() })}
            placeholder="http://localhost:11434/v1"
          />
        </Field>
        <Field label="Model" description="Model name as understood by that endpoint, e.g. qwen2.5:1.5b">
          <Input
            width={40}
            value={ai.model}
            onChange={(e: ChangeEvent<HTMLInputElement>) => patchAi({ model: e.target.value.trim() })}
            placeholder="qwen2.5:1.5b"
          />
        </Field>
        <Field label="API token (optional)" description="Leave blank for endpoints with no auth (e.g. local Ollama).">
          <Input
            width={40}
            type="password"
            value={ai.token ?? ''}
            onChange={(e: ChangeEvent<HTMLInputElement>) => patchAi({ token: e.target.value })}
            placeholder="sk-…"
          />
        </Field>
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
    max-width: 780px;
    padding: ${theme.spacing(2)};
  `,
  sectionTitle: css`
    margin: 0;
    font-size: ${theme.typography.h5.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
  `,
  viewListHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: ${theme.spacing(1.5)};
  `,
  empty: css`
    padding: ${theme.spacing(2)};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    border: 1px dashed ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    margin-bottom: ${theme.spacing(2)};
  `,
  viewList: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    margin-bottom: ${theme.spacing(2)};
  `,
  viewCard: css`
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    overflow: hidden;
  `,
  viewCardActive: css`
    border-color: ${theme.colors.primary.border};
  `,
  viewCardHeader: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
    background: ${theme.colors.background.secondary};
  `,
  viewCardName: css`
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  viewCardSub: css`
    color: ${theme.colors.text.disabled};
    font-size: 0.78em;
    flex: 1;
  `,
  viewCardActions: css`
    display: flex;
    gap: ${theme.spacing(0.5)};
    margin-left: auto;
  `,
  viewEditor: css`
    padding: ${theme.spacing(2)};
    background: ${theme.colors.background.primary};
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
