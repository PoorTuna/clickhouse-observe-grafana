/**
 * Build Grafana dashboard-panel JSON from the Logs Explorer's current query state.
 * Pure functions, no React — the current filters/search/columns/sort are already baked into
 * the generated SQL (buildLogsQuery / buildVolumeQuery), and the SQL uses $__fromTime/$__toTime
 * (+ $__timeInterval for the histogram bucket width), so exported panels stay time-picker-aware
 * on the destination dashboard instead of freezing the range/interval at export time.
 */
import { LogsQueryState, SourceConfig } from '../types';
import { buildLogsQuery, buildVolumeQuery, VolumeBreakdown } from '../sql/queryBuilder';

export const CH_DATASOURCE_TYPE = 'grafana-clickhouse-datasource';

export interface DataSourceRef {
  type: string;
  uid: string;
}

export interface GridPos {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ExportedPanel {
  id: number;
  type: string;
  title: string;
  gridPos: GridPos;
  datasource: DataSourceRef;
  targets: Array<{
    refId: string;
    datasource: DataSourceRef;
    editorType: 'sql';
    format: number;
    rawSql: string;
  }>;
  transformations?: Array<{ id: string; options: Record<string, unknown> }>;
  options?: Record<string, unknown>;
  fieldConfig?: { defaults: Record<string, unknown>; overrides: unknown[] };
}

// The ClickHouse datasource's query-editor Format enum — Table=1 is confirmed in src/data/runQuery.ts.
// Both exported panels use Table + client-side (transformation) shaping rather than guessing at
// an unverified TimeSeries enum value, so this stays correct regardless of the installed CH
// datasource version.
const FORMAT_TABLE = 1;

export function chDatasourceRef(datasourceUid: string): DataSourceRef {
  return { type: CH_DATASOURCE_TYPE, uid: datasourceUid };
}

export interface PanelExportOpts {
  id: number;
  title?: string;
  gridPos: GridPos;
}

/** Build a "table" panel showing the current logs query. */
export function buildTablePanel(
  config: SourceConfig,
  state: LogsQueryState,
  opts: PanelExportOpts
): ExportedPanel {
  const datasource = chDatasourceRef(config.datasourceUid);
  const rawSql = buildLogsQuery(config, state);
  return {
    id: opts.id,
    type: 'table',
    title: opts.title ?? 'Logs',
    gridPos: opts.gridPos,
    datasource,
    targets: [{ refId: 'A', datasource, editorType: 'sql', format: FORMAT_TABLE, rawSql }],
  };
}

/**
 * Build a "barchart" panel showing the current volume histogram.
 * `breakdown` should already be resolved via resolveVolumeBreakdown() from the UI-level
 * BreakdownSel, same as the live in-app histogram query.
 * The long time/level/count rows are pivoted into per-level series via transformations,
 * since the query itself always runs in Table format.
 */
export function buildHistogramPanel(
  config: SourceConfig,
  state: LogsQueryState,
  breakdown: VolumeBreakdown,
  opts: PanelExportOpts
): ExportedPanel {
  const datasource = chDatasourceRef(config.datasourceUid);
  const rawSql = buildVolumeQuery(config, state, { interval: { macro: true }, breakdown });
  return {
    id: opts.id,
    type: 'barchart',
    title: opts.title ?? 'Log volume',
    gridPos: opts.gridPos,
    datasource,
    targets: [{ refId: 'A', datasource, editorType: 'sql', format: FORMAT_TABLE, rawSql }],
    // Pivot long rows (time, level, count) into one series per level, then into a wide
    // time-series frame the barchart panel can render — same shape the app already
    // produces client-side in LogsExplorer's volume-row folding logic.
    transformations: [
      { id: 'partitionByValues', options: { fields: ['level'], keepFields: false } },
      { id: 'prepareTimeSeries', options: { format: 'many' } },
    ],
    options: { xField: 'time' },
    fieldConfig: { defaults: {}, overrides: [] },
  };
}

export function buildNewDashboard(panels: ExportedPanel[], title: string): Record<string, unknown> {
  return {
    title,
    panels,
    schemaVersion: 39,
    version: 0,
    time: { from: 'now-1h', to: 'now' },
    timezone: '',
    editable: true,
  };
}

/**
 * Append panels to an existing dashboard's JSON model, offsetting gridPos.y below whatever is
 * already there and assigning ids that don't collide with existing panel ids.
 */
export function appendPanelsToDashboard(
  dashboard: Record<string, unknown>,
  panels: ExportedPanel[]
): Record<string, unknown> {
  const existingPanels = Array.isArray(dashboard.panels)
    ? (dashboard.panels as Array<{ id?: number; gridPos?: GridPos }>)
    : [];
  const maxY = existingPanels.reduce((m, p) => (p.gridPos ? Math.max(m, p.gridPos.y + p.gridPos.h) : m), 0);
  const maxId = existingPanels.reduce((m, p) => Math.max(m, Number(p.id) || 0), 0);
  const offsetPanels = panels.map((p, i) => ({
    ...p,
    id: maxId + i + 1,
    gridPos: { ...p.gridPos, y: maxY + p.gridPos.y },
  }));
  return { ...dashboard, panels: [...existingPanels, ...offsetPanels] };
}
