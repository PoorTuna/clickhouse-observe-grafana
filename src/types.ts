import { FieldModel } from './sql/fieldModel';

// SourceConfig: persisted in plugin jsonData. Drives all SQL generation.

export interface ColumnMapping {
  timestamp: string;
  body: string;
  severity: string;
  // Trace ID column — powers the "open trace in Explore" link in the log detail drawer.
  traceId: string;
  serviceName: string;
  // Map column — empty string means column absent.
  spanAttributes: string;
}

export const OTEL_COLUMN_MAPPING: ColumnMapping = {
  timestamp: 'Timestamp',
  body: 'Body',
  severity: 'SeverityText',
  traceId: 'TraceId',
  serviceName: 'ServiceName',
  spanAttributes: 'SpanAttributes',
};

export const EMPTY_COLUMN_MAPPING: ColumnMapping = {
  timestamp: '',
  body: '',
  severity: '',
  traceId: '',
  serviceName: '',
  spanAttributes: '',
};

export interface SourceConfig {
  datasourceUid: string;
  database: string;
  logsTable: string;
  // Legacy flag, no longer read by SQL generation — all paths use columns.* mapping.
  // Kept for backwards-compat with persisted jsonData; new views leave it false.
  isOtel: boolean;
  columns: ColumnMapping;
  /**
   * Extra non-core columns this view loads with the grid by default, in display order — e.g.
   * "LogAttributes.http.method". Appended after the fixed core columns (Time/Level/Service/
   * Message), never replaces them; core columns are always emitted regardless of this list (see
   * defaultColumns() in LogsExplorer.tsx). Undefined/empty = today's core-only behavior. Labeled
   * "Pinned columns" in the UI — "pinned" means saved with the view, not position-locked; they
   * remain reorderable/removable in the grid like any manually-added column (isCore: false).
   */
  pinnedColumns?: SelectedColumn[];
}

export const DEFAULT_SOURCE_CONFIG: SourceConfig = {
  datasourceUid: '',
  database: 'default',
  logsTable: '',
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

export type ColumnType = 'time' | 'level' | 'text' | 'number' | 'string' | 'exact' | 'map' | 'json' | 'tuple' | 'array' | 'unknown';

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

/** A named, storable view over a single logs table — superset of SourceConfig. */
export interface DataView extends SourceConfig {
  id: string;
  name: string;
  /** 'shared' = stored in plugin jsonData by admin; 'personal' = localStorage per-browser. */
  origin: 'shared' | 'personal';
  createdAt: string;
}

/**
 * AI provider config for the "Guess with AI" column-mapping assist. Points at any
 * OpenAI-compatible `/chat/completions` endpoint (hosted or self-hosted, e.g. Ollama).
 * NOTE: `token` is stored in plain jsonData (not secureJsonData), so it is readable by any
 * browser user of this plugin — acceptable for local/self-hosted use, NOT a secret store.
 * Do not put a production API key with broad billing access here.
 */
export interface AiProviderConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  token?: string;
}

// Plugin jsonData shape
export interface AppJsonData {
  /** Admin-managed shared data views (v1+). */
  dataViews?: DataView[];
  /** ID of the view that is active by default for all users. */
  defaultDataViewId?: string;
  /** LEGACY single-source config — migrated to a shared DataView on load. */
  sourceConfig?: SourceConfig;
  /** AI column-mapping assist settings, admin-configured. */
  ai?: AiProviderConfig;
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
