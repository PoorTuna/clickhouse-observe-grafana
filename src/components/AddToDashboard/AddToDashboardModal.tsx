/**
 * "Add to dashboard" modal — exports the current logs table + volume histogram as real
 * Grafana panels onto a new or existing dashboard. Mirrors the Modal/Field/Select/Alert
 * pattern used by CreateDataViewModal and SavedSearchMenu's save modal.
 */
import React, { useEffect, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, SelectableValue } from '@grafana/data';
import { locationService } from '@grafana/runtime';
import {
  Alert,
  Button,
  Checkbox,
  Field,
  Input,
  Modal,
  RadioButtonGroup,
  Select,
  Spinner,
  useStyles2,
} from '@grafana/ui';
import { BreakdownSel, LogsQueryState, SourceConfig } from '../../types';
import { ViewCapabilities } from '../../sql/capabilities';
import { resolveVolumeBreakdown } from '../../sql/queryBuilder';
import {
  appendPanelsToDashboard,
  buildHistogramPanel,
  buildNewDashboard,
  buildTablePanel,
  ExportedPanel,
} from '../../data/panelExport';
import { getDashboard, saveDashboard, searchDashboards } from '../../data/dashboards';

interface AddToDashboardModalProps {
  isOpen: boolean;
  onDismiss: () => void;
  config: SourceConfig;
  /** Query state with effective (default-derived) columns already merged in. */
  queryState: LogsQueryState;
  breakdown: BreakdownSel;
  caps: ViewCapabilities;
}

type Destination = 'new' | 'existing';

export function AddToDashboardModal({
  isOpen,
  onDismiss,
  config,
  queryState,
  breakdown,
  caps,
}: AddToDashboardModalProps) {
  const styles = useStyles2(getStyles);

  const [includeTable, setIncludeTable] = useState(true);
  const [includeHistogram, setIncludeHistogram] = useState(caps.hasTime);
  const [destination, setDestination] = useState<Destination>('new');
  const [newTitle, setNewTitle] = useState('Logs Explorer export');
  const [existingUid, setExistingUid] = useState<string | undefined>(undefined);
  // null = not fetched yet (also doubles as the "loading" signal for the existing-dashboard picker).
  const [dashboardOptions, setDashboardOptions] = useState<Array<SelectableValue<string>> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Reset transient state each time the modal transitions from closed to open.
  // Adjusted during render (not in an effect) per React's "adjusting state on prop change" pattern —
  // avoids the extra render an effect-based reset would cause.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setIncludeTable(true);
      setIncludeHistogram(caps.hasTime);
      setDestination('new');
      setNewTitle('Logs Explorer export');
      setExistingUid(undefined);
      setDashboardOptions(null);
      setError('');
    }
  }

  // Populate the existing-dashboard picker lazily, only when that destination is chosen.
  useEffect(() => {
    if (!isOpen || destination !== 'existing' || dashboardOptions !== null) {
      return;
    }
    let cancelled = false;
    searchDashboards()
      .then((hits) => {
        if (cancelled) {
          return;
        }
        setDashboardOptions(
          hits.map((h) => ({ label: h.folderTitle ? `${h.folderTitle} / ${h.title}` : h.title, value: h.uid }))
        );
      })
      .catch((e) => {
        if (!cancelled) {
          setError(`Failed to load dashboards: ${(e as Error)?.message ?? e}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, destination, dashboardOptions]);

  const loadingDashboards = destination === 'existing' && dashboardOptions === null;

  const canSave =
    (includeTable || includeHistogram) &&
    (destination === 'new' ? Boolean(newTitle.trim()) : Boolean(existingUid)) &&
    !saving;

  function buildPanels(): ExportedPanel[] {
    const panels: ExportedPanel[] = [];
    let id = 1;
    let y = 0;
    if (includeTable) {
      panels.push(
        buildTablePanel(config, queryState, { id: id++, gridPos: { x: 0, y, w: 24, h: 10 } })
      );
      y += 10;
    }
    if (includeHistogram) {
      const volBreakdown = resolveVolumeBreakdown(breakdown, config);
      panels.push(
        buildHistogramPanel(config, queryState, volBreakdown, { id: id++, gridPos: { x: 0, y, w: 24, h: 8 } })
      );
      y += 8;
    }
    return panels;
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      const panels = buildPanels();
      const result =
        destination === 'new'
          ? await saveDashboard(buildNewDashboard(panels, newTitle.trim()))
          : await (async () => {
              const existing = await getDashboard(existingUid as string);
              const merged = appendPanelsToDashboard(existing.dashboard, panels);
              return saveDashboard(merged, { folderUid: existing.meta.folderUid, overwrite: true });
            })();
      onDismiss();
      locationService.push(result.url);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Add to dashboard" isOpen={isOpen} onDismiss={onDismiss}>
      {error && (
        <Alert title="Error" severity="error" className={styles.alert}>
          {error}
        </Alert>
      )}

      <Field label="Panels to add">
        <div className={styles.checkboxes}>
          <Checkbox label="Logs table" value={includeTable} onChange={(e) => setIncludeTable(e.currentTarget.checked)} />
          {caps.hasTime && (
            <Checkbox
              label="Volume histogram"
              value={includeHistogram}
              onChange={(e) => setIncludeHistogram(e.currentTarget.checked)}
            />
          )}
        </div>
      </Field>

      <Field label="Destination">
        <RadioButtonGroup
          value={destination}
          onChange={(v) => setDestination(v as Destination)}
          options={[
            { label: 'New dashboard', value: 'new' },
            { label: 'Existing dashboard', value: 'existing' },
          ]}
        />
      </Field>

      {destination === 'new' ? (
        <Field label="Dashboard title" required>
          <Input value={newTitle} onChange={(e) => setNewTitle(e.currentTarget.value)} autoFocus />
        </Field>
      ) : (
        <Field label="Dashboard" required>
          {loadingDashboards ? (
            <Spinner size="sm" />
          ) : (
            <Select
              width={40}
              value={existingUid}
              options={dashboardOptions ?? []}
              onChange={(opt) => setExistingUid(opt.value)}
              placeholder="Select dashboard…"
            />
          )}
        </Field>
      )}

      <div className={styles.actions}>
        <Button variant="secondary" onClick={onDismiss} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSave} disabled={!canSave}>
          {saving ? <Spinner size="sm" inline /> : 'Add to dashboard'}
        </Button>
      </div>
    </Modal>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  alert: css`
    margin-bottom: ${theme.spacing(2)};
  `,
  checkboxes: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  actions: css`
    display: flex;
    justify-content: flex-end;
    gap: ${theme.spacing(1)};
    margin-top: ${theme.spacing(2)};
  `,
});
