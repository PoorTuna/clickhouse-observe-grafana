// SourceConfig: persisted in plugin jsonData. Drives all SQL generation.

export interface ColumnMapping {
  timestamp: string;
  body: string;
  severity: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  serviceName: string;
  duration: string;
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
  traceId: 'TraceId',
  spanId: 'SpanId',
  parentSpanId: 'ParentSpanId',
  serviceName: "ResourceAttributes['service.name']",
  duration: 'Duration',
  resourceAttributes: 'ResourceAttributes',
  logAttributes: 'LogAttributes',
  scopeAttributes: 'ScopeAttributes',
  spanAttributes: 'SpanAttributes',
};

export const EMPTY_COLUMN_MAPPING: ColumnMapping = {
  timestamp: '',
  body: '',
  severity: '',
  traceId: '',
  spanId: '',
  parentSpanId: '',
  serviceName: '',
  duration: '',
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
  isOtel: boolean;
  columns: ColumnMapping;
}

export const DEFAULT_SOURCE_CONFIG: SourceConfig = {
  datasourceUid: '',
  database: 'default',
  logsTable: 'otel_logs',
  tracesTable: 'otel_traces',
  isOtel: true,
  columns: OTEL_COLUMN_MAPPING,
};

export type FilterOp = '=' | '!=' | 'contains' | 'not_contains';

export interface FilterPill {
  id: string;
  field: string;
  op: FilterOp;
  value: string;
}

export interface LogsQueryState {
  search: string;
  filters: FilterPill[];
  rawSql: string;
  useRawSql: boolean;
  limit: number;
}

export const DEFAULT_LOGS_QUERY_STATE: LogsQueryState = {
  search: '',
  filters: [],
  rawSql: '',
  useRawSql: false,
  limit: 200,
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
  duration: number;
  statusCode: string;
  tags: string;
}

// Plugin jsonData shape
export interface AppJsonData {
  sourceConfig?: SourceConfig;
}
