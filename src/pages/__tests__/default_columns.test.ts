/**
 * defaultColumns() feeds effectiveColumns whenever the user hasn't touched the grid yet — the
 * fallback that decides what a freshly-opened data view shows. "Pinned columns" (SourceConfig.
 * pinnedColumns) appends extra saved columns after the fixed core set without ever replacing or
 * duplicating it; these tests pin down that contract.
 */
import { defaultColumns } from '../LogsExplorer';
import { CORE_ALIAS } from '../../sql/queryBuilder';
import { EMPTY_COLUMN_MAPPING, SelectedColumn, SourceConfig } from '../../types';

const otelConfig: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'otel_logs',
  isOtel: true,
  columns: {
    ...EMPTY_COLUMN_MAPPING,
    timestamp: 'Timestamp',
    body: 'Body',
    severity: 'SeverityText',
    serviceName: 'ServiceName',
  },
};

function pinned(sqlExpr: string, id = sqlExpr): SelectedColumn {
  return { id, key: `fld_${id}`, sqlExpr, displayName: id, type: 'string', isCore: false };
}

describe('defaultColumns', () => {
  it('returns just the core columns when pinnedColumns is unset (today\'s behavior)', () => {
    const cols = defaultColumns(otelConfig);
    expect(cols.map((c) => c.id)).toEqual(['timestamp', 'severity', 'serviceName', 'body']);
    expect(cols.every((c) => c.isCore)).toBe(true);
  });

  it('appends pinned columns after core, preserving order', () => {
    const cfg: SourceConfig = {
      ...otelConfig,
      pinnedColumns: [pinned("LogAttributes['http.method']"), pinned("ResourceAttributes['k8s.pod.name']")],
    };
    const cols = defaultColumns(cfg);
    expect(cols.map((c) => c.sqlExpr)).toEqual([
      'Timestamp',
      'SeverityText',
      'ServiceName',
      'Body',
      "LogAttributes['http.method']",
      "ResourceAttributes['k8s.pod.name']",
    ]);
    expect(cols.slice(4).every((c) => !c.isCore)).toBe(true);
  });

  it('drops a pinned column that duplicates a mapped core sqlExpr', () => {
    const cfg: SourceConfig = {
      ...otelConfig,
      pinnedColumns: [pinned('ServiceName'), pinned("LogAttributes['http.method']")],
    };
    const cols = defaultColumns(cfg);
    expect(cols.filter((c) => c.sqlExpr === 'ServiceName')).toHaveLength(1);
    expect(cols.map((c) => c.sqlExpr)).toContain("LogAttributes['http.method']");
  });

  it('respects CORE_ALIAS keys for the core columns it does return', () => {
    const cols = defaultColumns(otelConfig);
    const timestampCol = cols.find((c) => c.id === 'timestamp');
    expect(timestampCol?.key).toBe(CORE_ALIAS.timestamp);
  });
});
