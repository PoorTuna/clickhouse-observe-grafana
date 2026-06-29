/**
 * Thin wrapper to run raw SQL through the installed ClickHouse datasource.
 * The CH datasource backend handles $__fromTime / $__toTime macro expansion.
 */

import { DataQuery, DataQueryRequest, DataFrame, TimeRange } from '@grafana/data';
import { getDataSourceSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';

// CH datasource format enum (Table = 1). Must match their src/types/sql.ts.
const FORMAT_TABLE = 1;

interface ChTarget extends DataQuery {
  rawSql: string;
  editorType: 'sql';
  format: number;
}

export interface RunQueryOptions {
  datasourceUid: string;
  sql: string;
  timeRange: TimeRange;
  refId?: string;
  maxDataPoints?: number;
}

export async function runQuery(options: RunQueryOptions): Promise<DataFrame[]> {
  const { datasourceUid, sql, timeRange, refId = 'A', maxDataPoints = 5000 } = options;

  const ds = await getDataSourceSrv().get(datasourceUid);

  const target: ChTarget = {
    refId,
    rawSql: sql,
    editorType: 'sql',
    format: FORMAT_TABLE,
  };

  const request: DataQueryRequest<ChTarget> = {
    requestId: `ch-observe-${Date.now()}`,
    app: 'dashboard',
    interval: '1m',
    intervalMs: 60000,
    maxDataPoints,
    range: timeRange,
    scopedVars: {},
    targets: [target],
    timezone: 'browser',
    startTime: Date.now(),
  };

  const response = await lastValueFrom(ds.query(request));
  return response.data as DataFrame[];
}

/** Convert a DataFrame into an array of plain row objects. */
export function dataFrameToRows(frame: DataFrame): Record<string, unknown>[] {
  if (!frame || frame.length === 0) {
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < frame.length; i++) {
    const row: Record<string, unknown> = {};
    for (const field of frame.fields) {
      // The ClickHouse Grafana datasource prefixes Map-typed column names with
      // "_f_col_" in the DataFrame. Strip it so downstream code sees the SQL alias.
      const name = field.name.replace(/^_f_col_/, '');
      row[name] = field.values[i];
    }
    rows.push(row);
  }
  return rows;
}

/** Run a query and return rows from the first DataFrame. */
export async function runQueryRows(
  options: RunQueryOptions
): Promise<Record<string, unknown>[]> {
  const frames = await runQuery(options);
  if (!frames || frames.length === 0) {
    return [];
  }
  return dataFrameToRows(frames[0]);
}
