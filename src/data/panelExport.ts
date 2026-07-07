/**
 * Build Grafana dashboard-panel JSON from the Logs Explorer's current query state.
 * Pure functions, no React — the current filters/search/columns/sort are already baked into
 * the generated SQL (buildLogsQuery / buildVolumeQuery), and the SQL uses $__fromTime/$__toTime
 * (+ $__timeInterval for the histogram bucket width), so exported panels stay time-picker-aware
 * on the destination dashboard instead of freezing the range/interval at export time.
 */
import { LogsQueryState, SourceConfig } from '../types';
import { buildLogsQuery, buildVolumeQuery, VolumeBreakdown } from '../sql/queryBuilder';
import { FieldIndex } from '../sql/fields';

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
  opts: PanelExportOpts,
  index?: FieldIndex
): ExportedPanel {
  const datasource = chDatasourceRef(config.datasourceUid);
  const rawSql = buildLogsQuery(config, state, undefined, undefined, index);
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
 * Build a "timeseries" panel (rendered as bars) showing the current volume histogram.
 * `breakdown` should already be resolved via resolveVolumeBreakdown() from the UI-level
 * BreakdownSel, same as the live in-app histogram query.
 * The long time/level/count rows are pivoted into per-level series via transformations,
 * since the query itself always runs in Table format.
 *
 * Deliberately NOT a "barchart" panel — barchart treats every row as a discrete category
 * (Grafana's own docs: "for large amounts of time-series data, we recommend that you use the
 * time series visualization" instead), so a ~50-60-bucket histogram rendered as a barchart
 * produced one raw-epoch category tick per bucket, all overlapping/unreadable, with bars grouped
 * side-by-side instead of stacked. `prepareTimeSeries`'s `format: 'many'` output (one frame per
 * series, each with a real time-typed field) is the shape a timeseries panel expects — pairing it
 * with `drawStyle: 'bars'` + `stacking` reproduces the barchart look while keeping a proper,
 * auto-formatted/decimated time axis.
 */
export function buildHistogramPanel(
  config: SourceConfig,
  state: LogsQueryState,
  breakdown: VolumeBreakdown,
  opts: PanelExportOpts,
  index?: FieldIndex
): ExportedPanel {
  const datasource = chDatasourceRef(config.datasourceUid);
  const rawSql = buildVolumeQuery(config, state, { interval: { macro: true }, breakdown }, index);
  return {
    id: opts.id,
    type: 'timeseries',
    title: opts.title ?? 'Log volume',
    gridPos: opts.gridPos,
    datasource,
    targets: [{ refId: 'A', datasource, editorType: 'sql', format: FORMAT_TABLE, rawSql }],
    // Pivot long rows (time, level, count) into one series per level, then into per-series
    // time-series frames — the shape a timeseries panel consumes — same grouping the app already
    // does client-side in LogsExplorer's volume-row folding logic.
    transformations: [
      { id: 'partitionByValues', options: { fields: ['level'], keepFields: false } },
      { id: 'prepareTimeSeries', options: { format: 'many' } },
    ],
    options: {},
    fieldConfig: {
      defaults: { custom: { drawStyle: 'bars', fillOpacity: 100, stacking: { mode: 'normal', group: 'A' } } },
      overrides: [],
    },
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
