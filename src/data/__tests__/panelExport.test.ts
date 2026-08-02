/**
 * Unit tests for panelExport.ts — verifies exported panel JSON carries the datasource ref,
 * time/interval macros (so panels stay dashboard-time-relative), and current filters/search;
 * also verifies dashboard-append offsets gridPos and assigns non-colliding ids.
 */
import { appendPanelsToDashboard, buildHistogramPanel, buildNewDashboard, buildTablePanel, chDatasourceRef } from '../panelExport';
import { DEFAULT_LOGS_QUERY_STATE, FilterPill, OTEL_COLUMN_MAPPING, SourceConfig } from '../../types';

const config: SourceConfig = {
  datasourceUid: 'ds-uid-1',
  database: 'default',
  logsTable: 'otel_logs',
  isOtel: true,
  columns: OTEL_COLUMN_MAPPING,
};

const filterPill: FilterPill = { id: 'f1', field: 'ServiceName', op: '=', value: 'checkout' };

describe('chDatasourceRef', () => {
  it('builds the ClickHouse datasource ref by uid', () => {
    expect(chDatasourceRef('abc')).toEqual({ type: 'grafana-clickhouse-datasource', uid: 'abc' });
  });
});

describe('buildTablePanel', () => {
  it('embeds the datasource ref, time macros, and current filters in the target SQL', () => {
    const state = { ...DEFAULT_LOGS_QUERY_STATE, search: 'timeout', filters: [filterPill] };
    const panel = buildTablePanel(config, state, { id: 1, gridPos: { x: 0, y: 0, w: 24, h: 10 } });

    expect(panel.type).toBe('table');
    expect(panel.id).toBe(1);
    expect(panel.datasource).toEqual({ type: 'grafana-clickhouse-datasource', uid: 'ds-uid-1' });
    expect(panel.targets).toHaveLength(1);
    const target = panel.targets[0];
    expect(target.editorType).toBe('sql');
    expect(target.datasource).toEqual(panel.datasource);
    expect(target.rawSql).toContain('$__fromTime');
    expect(target.rawSql).toContain('$__toTime');
    expect(target.rawSql).toContain("'checkout'"); // filter pill value
  });
});

describe('buildHistogramPanel', () => {
  it('uses the adaptive $__timeInterval macro instead of a frozen bucket width', () => {
    const panel = buildHistogramPanel(
      config,
      DEFAULT_LOGS_QUERY_STATE,
      { kind: 'none' },
      { id: 2, gridPos: { x: 0, y: 10, w: 24, h: 8 } }
    );

    // "timeseries" (not "barchart") — barchart treats every bucket as a discrete category,
    // which overlaps unreadable raw-epoch tick labels once there are ~50+ buckets. See the
    // doc comment on buildHistogramPanel.
    expect(panel.type).toBe('timeseries');
    expect(panel.targets[0].rawSql).toContain('$__timeInterval(');
    expect(panel.targets[0].rawSql).not.toMatch(/toStartOfInterval/);
    // Long time/level/count rows are pivoted into series client-side.
    expect(panel.transformations?.map((t) => t.id)).toEqual(['partitionByValues', 'prepareTimeSeries']);
    // Bars + stacked, reproducing the barchart look on a panel type with a real time axis.
    expect(panel.fieldConfig?.defaults).toMatchObject({
      custom: { drawStyle: 'bars', stacking: { mode: 'normal', group: 'A' } },
    });
  });

  it('reflects a severity breakdown in the generated SQL', () => {
    const panel = buildHistogramPanel(
      config,
      DEFAULT_LOGS_QUERY_STATE,
      { kind: 'severity', expr: config.columns.severity },
      { id: 2, gridPos: { x: 0, y: 0, w: 24, h: 8 } }
    );
    expect(panel.targets[0].rawSql).toContain(`toString(${config.columns.severity}) AS level`);
    expect(panel.targets[0].rawSql).not.toContain('lower(');
  });
});

describe('buildNewDashboard', () => {
  it('wraps panels in a minimal dashboard model', () => {
    const panel = buildTablePanel(config, DEFAULT_LOGS_QUERY_STATE, { id: 1, gridPos: { x: 0, y: 0, w: 24, h: 10 } });
    const dashboard = buildNewDashboard([panel], 'My export');
    expect(dashboard.title).toBe('My export');
    expect(dashboard.panels).toEqual([panel]);
  });
});

describe('appendPanelsToDashboard', () => {
  it('offsets new panels below existing ones and avoids id collisions', () => {
    const existing = {
      title: 'Existing',
      panels: [
        { id: 5, gridPos: { x: 0, y: 0, w: 24, h: 6 } },
        { id: 7, gridPos: { x: 0, y: 6, w: 24, h: 4 } },
      ],
    };
    const newPanel = buildTablePanel(config, DEFAULT_LOGS_QUERY_STATE, { id: 1, gridPos: { x: 0, y: 0, w: 24, h: 10 } });

    const merged = appendPanelsToDashboard(existing, [newPanel]);
    const panels = merged.panels as Array<{ id: number; gridPos: { y: number } }>;

    expect(panels).toHaveLength(3);
    expect(panels[2].id).toBe(8); // max existing id (7) + 1
    expect(panels[2].gridPos.y).toBe(10); // max existing y+h (6+4) + panel's own y (0)
  });
});
