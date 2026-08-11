/**
 * Thin wrapper to run raw SQL through the installed ClickHouse datasource.
 * The CH datasource backend handles $__fromTime / $__toTime macro expansion.
 */

import { DataQuery, DataQueryError, DataQueryRequest, DataFrame, DataQueryResponse, TimeRange } from '@grafana/data';
import { getDataSourceSrv } from '@grafana/runtime';
import { lastValueFrom, from, Observable } from 'rxjs';

// CH datasource format enum (Table = 1). Must match their src/types/sql.ts.
const FORMAT_TABLE = 1;

interface ChTarget extends DataQuery {
  rawSql: string;
  editorType: 'sql';
  format: number;
}

/**
 * Extracts every piece of information a DataQueryError actually carries, instead of picking one
 * field and discarding the rest. `.message` is usually the whole ClickHouse exception text, but
 * `.data.message`/`.data.error` (dev-mode detail) and `.status`/`.statusText` (e.g. 504 from a
 * proxy timing out before ClickHouse itself responds) can be the only signal present when
 * `.message` is empty or generic — never collapse those into a fixed "query failed" string, or a
 * real timeout/permissions/network distinction gets thrown away right when it matters most.
 */
function formatDataQueryError(err: DataQueryError): string {
  const parts = [
    err.message,
    err.data?.message,
    err.data?.error,
    err.status != null ? `HTTP ${err.status}${err.statusText ? ` ${err.statusText}` : ''}` : undefined,
  ].filter((p): p is string => Boolean(p && p.trim()));
  if (parts.length > 0) {
    // dedupe: .message and .data.message are frequently the same string verbatim.
    return Array.from(new Set(parts)).join(' — ');
  }
  // No known field had anything — surface the raw object rather than a generic placeholder, so
  // whatever shape the backend actually sent is still visible instead of silently discarded.
  try {
    return `ClickHouse query failed: ${JSON.stringify(err)}`;
  } catch {
    return 'ClickHouse query failed with an error that could not be serialized.';
  }
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
    requestId: `ch-observe-${refId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
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

  const result = ds.query(request);
  const response = await lastValueFrom(
    (result instanceof Observable ? result : from(result)) as Observable<DataQueryResponse>
  );
  // The datasource resolves (never rejects) on a backend-reported query failure — Grafana's
  // DataQueryResponse carries `.error`/`.errors` *alongside* `.data` rather than throwing (see
  // @grafana/runtime's toDataQueryResponse, and CHDatasource.query()'s own catchError, which both
  // only ever emit a resolved value). Without this check every ClickHouse error (bad SQL, a
  // `timeout_overflow_mode = 'throw'` guardrail firing, permissions) would silently surface here as
  // an empty/partial `data` array instead of a catchable error.
  if (response.errors?.length || response.error) {
    // Prefer .errors[0] (the newer, non-deprecated field) but fall back to .error — either can be
    // populated alone depending on which layer produced it (see runQuery.ts's C0 doc comment
    // above). Every field either one carries is surfaced via formatDataQueryError, never just one.
    const err = response.errors?.[0] ?? response.error!;
    throw new Error(formatDataQueryError(err));
  }
  return response.data as DataFrame[];
}

/** Convert a DataFrame into an array of plain row objects. */
export function dataFrameToRows(frame: DataFrame): Array<Record<string, unknown>> {
  if (!frame || frame.length === 0) {
    return [];
  }
  const rows: Array<Record<string, unknown>> = [];
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
): Promise<Array<Record<string, unknown>>> {
  const frames = await runQuery(options);
  if (!frames || frames.length === 0) {
    return [];
  }
  return dataFrameToRows(frames[0]);
}
