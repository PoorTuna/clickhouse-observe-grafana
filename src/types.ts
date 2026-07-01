import { FieldModel } from './sql/fieldModel';

// SourceConfig: persisted in plugin jsonData. Drives all SQL generation.

export interface ColumnMapping {
  timestamp: string;
  body: string;
  severity: string;
  // Numeric severity column (e.g. OTel SeverityNumber) — empty means absent.
  severityNumber: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  serviceName: string;
  duration: string;
  // Span name / operation name column — empty means absent.
  spanName: string;
  // Span status code column (e.g. OTel StatusCode) — empty means absent.
  statusCode: string;
  // Map columns — empty string means column absent (non-OTel tables)
  resourceAttributes: string;
  logAttributes: string;
  scopeAttributes: string;
  spanAttributes: string;
}

export const OTEL_COLUMN_MAPPING: ColumnMapping = {
  timestamp: 'Timestamp',
  body: 'Body',
  severity: 'SeverityText',
  severityNumber: 'SeverityNumber',
  traceId: 'TraceId',
  spanId: 'SpanId',
  parentSpanId: 'ParentSpanId',
  serviceName: 'ServiceName',
  duration: 'Duration',
  spanName: 'SpanName',
  statusCode: 'StatusCode',
  resourceAttributes: 'ResourceAttributes',
  logAttributes: 'LogAttributes',
  scopeAttributes: 'ScopeAttributes',
  spanAttributes: 'SpanAttributes',
};

export const EMPTY_COLUMN_MAPPING: ColumnMapping = {
  timestamp: '',
  body: '',
  severity: '',
  severityNumber: '',
  traceId: '',
  spanId: '',
  parentSpanId: '',
  serviceName: '',
  duration: '',
  spanName: '',
  statusCode: '',
  resourceAttributes: '',
  logAttributes: '',
  scopeAttributes: '',
  spanAttributes: '',
};

export interface SourceConfig {
  datasourceUid: string;
  database: string;
  logsTable: string;
  tracesTable: string;
  // Legacy flag, no longer read by SQL generation — all paths use columns.* mapping.
  // Kept for backwards-compat with persisted jsonData; new views leave it false.
  isOtel: boolean;
  columns: ColumnMapping;
}

export const DEFAULT_SOURCE_CONFIG: SourceConfig = {
  datasourceUid: '',
  database: 'default',
  logsTable: '',
  tracesTable: '',
  isOtel: false,
  columns: EMPTY_COLUMN_MAPPING,
};

export type FilterOp =
  | '='            // is
  | '!='           // is not
  | 'contains'     // contains
  | 'not_contains' // does not contain
  | 'one_of'       // is one of (IN)
  | 'not_one_of'   // is not one of (NOT IN)
  | 'exists'       // exists
  | 'not_exists';  // does not exist

export interface FilterPill {
  id: string;
  field: string;
  op: FilterOp;
  value: string;        // single-value ops; '' for multi / exists ops
  values?: string[];    // one_of / not_one_of
  label?: string;       // optional custom display label
}

export type ColumnType = 'time' | 'level' | 'text' | 'number' | 'string' | 'exact' | 'map' | 'unknown';

export interface SelectedColumn {
  id: string;           // stable identifier
  key: string;          // row-object key (alias in SELECT)
  sqlExpr: string;      // SQL expression
  displayName: string;
  type: ColumnType;
  isCore: boolean;      // core cols are always selected; user cols add extra SELECT clauses
}

export interface LogsQueryState {
  search: string;
  filters: FilterPill[];
  rawSql: string;
  useRawSql: boolean;
  limit: number;
  columns: SelectedColumn[];
  sort?: { col: string; dir: 'asc' | 'desc' };
}

/** Histogram time bucket granularity. 'auto' derives the best interval from the time range. */
export type IntervalMode = 'auto' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

/**
 * Histogram breakdown selection.
 * - 'none'     → plain single-color bars; no per-series coloring.
 * - 'severity' → stack by severity column (existing behavior, default when severity is mapped).
 * - 'field'    → top-10 CTE breakdown by a chosen field.
 */
export type BreakdownSel =
  | { kind: 'none' }
  | { kind: 'severity' }
  | { kind: 'field'; field: FieldModel };

export const DEFAULT_LOGS_QUERY_STATE: LogsQueryState = {
  search: '',
  filters: [],
  rawSql: '',
  useRawSql: false,
  limit: 200,
  columns: [],
  sort: undefined,
};

export type LogRow = Record<string, unknown>;

export interface VolumeDataPoint {
  time: number;
  levels: Record<string, number>;
}

export interface TraceRow {
  traceId: string;
  startTime: number;
  endTime: number;
  serviceName: string;
  spanCount: number;
  errorCount: number;
  duration: number;
}

export interface SpanRow {
  traceID: string;
  spanID: string;
  parentSpanID: string;
  serviceName: string;
  operationName: string;
  startTime: number;
  durationNs: number;
  statusCode: string;
  tags: string;
}

/** A named, storable view over a single logs table — superset of SourceConfig. */
export interface DataView extends SourceConfig {
  id: string;
  name: string;
  /** 'shared' = stored in plugin jsonData by admin; 'personal' = localStorage per-browser. */
  origin: 'shared' | 'personal';
  createdAt: string;
}

// Plugin jsonData shape
export interface AppJsonData {
  /** Admin-managed shared data views (v1+). */
  dataViews?: DataView[];
  /** ID of the view that is active by default for all users. */
  defaultDataViewId?: string;
  /** LEGACY single-source config — migrated to a shared DataView on load. */
  sourceConfig?: SourceConfig;
}

export interface SavedSearch {
  id: string;
  name: string;
  search: string;
  filters: FilterPill[];
  columns: SelectedColumn[];
  sort?: { col: string; dir: 'asc' | 'desc' };
  timeRange?: { from: string; to: string };
  createdAt: string;
  /** Scope this saved search to a specific data view; undefined = legacy (all views). */
  dataViewId?: string;
}
