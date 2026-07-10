import {
  buildTraceListQuery,
  buildTraceDetailQuery,
  buildTraceVolumeQuery,
  buildTraceWhereConditions,
} from '../queryBuilder';
import { DEFAULT_TRACE_LIST_FILTERS, OTEL_COLUMN_MAPPING, SourceConfig, TraceListFilters } from '../../types';

const otelConfig: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'otel_logs',
  tracesTable: 'otel_traces',
  isOtel: true,
  columns: OTEL_COLUMN_MAPPING,
};

const noTraceIdConfig: SourceConfig = {
  ...otelConfig,
  columns: { ...OTEL_COLUMN_MAPPING, traceId: '' },
};

describe('buildTraceListQuery', () => {
  it('returns empty string when traceId is unmapped', () => {
    expect(buildTraceListQuery(noTraceIdConfig, DEFAULT_TRACE_LIST_FILTERS)).toBe('');
  });

  it('emits root-service/root-operation aggregation gated on parentSpanId', () => {
    const sql = buildTraceListQuery(otelConfig, DEFAULT_TRACE_LIST_FILTERS);
    expect(sql).toContain('argMinIf(ServiceName, Timestamp, ParentSpanId = \'\')');
    expect(sql).toContain('AS rootServiceName');
    expect(sql).toContain('AS rootOperationName');
    expect(sql).toContain('GROUP BY traceId');
  });

  it('degrades gracefully (no "undefined") when parentSpanId/serviceName/spanName/timestamp/duration are unmapped', () => {
    const cfg: SourceConfig = {
      ...otelConfig,
      columns: { ...OTEL_COLUMN_MAPPING, parentSpanId: '', serviceName: '', spanName: '', timestamp: '', duration: '' },
    };
    const sql = buildTraceListQuery(cfg, DEFAULT_TRACE_LIST_FILTERS);
    expect(sql).not.toContain('undefined');
    expect(sql).toContain("'' AS rootServiceName");
    expect(sql).toContain("'' AS rootOperationName");
    expect(sql).toContain('0 AS startNs');
    expect(sql).toContain('0 AS endNs');
  });

  it('applies pagination LIMIT/OFFSET and sort column/direction', () => {
    const sql = buildTraceListQuery(
      otelConfig,
      DEFAULT_TRACE_LIST_FILTERS,
      { col: 'duration', dir: 'asc' },
      { limit: 25, offset: 50 }
    );
    expect(sql).toContain('ORDER BY durationNs ASC');
    expect(sql).toContain('LIMIT 25 OFFSET 50');
  });

  it('filters by status=error using the OTel status literal', () => {
    const filters: TraceListFilters = { ...DEFAULT_TRACE_LIST_FILTERS, status: 'error' };
    const sql = buildTraceListQuery(otelConfig, filters);
    expect(sql).toContain("StatusCode = 'STATUS_CODE_ERROR'");
  });

  it('filters by status=ok as "not error" (includes UNSET, not just OK)', () => {
    const filters: TraceListFilters = { ...DEFAULT_TRACE_LIST_FILTERS, status: 'ok' };
    const sql = buildTraceListQuery(otelConfig, filters);
    expect(sql).toContain("StatusCode != 'STATUS_CODE_ERROR'");
  });

  it('filters by service, spanName, spanKind, and duration bounds', () => {
    const filters: TraceListFilters = {
      ...DEFAULT_TRACE_LIST_FILTERS,
      service: 'checkout',
      spanName: 'POST /orders',
      spanKind: 'SERVER',
      minDurationNs: 1_000_000,
      maxDurationNs: 5_000_000_000,
    };
    const sql = buildTraceListQuery(otelConfig, filters);
    expect(sql).toContain("ServiceName ILIKE '%checkout%'");
    expect(sql).toContain("SpanName ILIKE '%POST /orders%'");
    expect(sql).toContain("SpanKind = 'SERVER'");
    expect(sql).toContain('Duration >= 1000000');
    expect(sql).toContain('Duration <= 5000000000');
  });

  it('uses KQL/body search when body is mapped (shared ColumnMapping with logs)', () => {
    const filters: TraceListFilters = { ...DEFAULT_TRACE_LIST_FILTERS, search: 'timeout' };
    const sql = buildTraceListQuery(otelConfig, filters);
    expect(sql).toContain("hasToken(Body, 'timeout')");
  });

  it('falls back to spanName ILIKE for free-text search when there is no body column mapped', () => {
    const cfg: SourceConfig = { ...otelConfig, columns: { ...OTEL_COLUMN_MAPPING, body: '' } };
    const filters: TraceListFilters = { ...DEFAULT_TRACE_LIST_FILTERS, search: 'timeout' };
    const sql = buildTraceListQuery(cfg, filters);
    expect(sql).toContain("SpanName ILIKE '%timeout%'");
  });

  it('skips duration filters entirely when duration is unmapped (never emits Duration >= ...)', () => {
    const cfg: SourceConfig = { ...otelConfig, columns: { ...OTEL_COLUMN_MAPPING, duration: '' } };
    const filters: TraceListFilters = { ...DEFAULT_TRACE_LIST_FILTERS, minDurationNs: 100, maxDurationNs: 200 };
    const sql = buildTraceListQuery(cfg, filters);
    expect(sql).not.toContain('>= 100');
    expect(sql).not.toContain('<= 200');
  });
});

describe('buildTraceWhereConditions', () => {
  it('returns no conditions for default (empty) filters when only timestamp is mapped', () => {
    const conditions = buildTraceWhereConditions(otelConfig, DEFAULT_TRACE_LIST_FILTERS);
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toContain('$__fromTime');
  });

  it('appends chip filter pills using the same buildFilterClause as logs', () => {
    const filters: TraceListFilters = {
      ...DEFAULT_TRACE_LIST_FILTERS,
      pills: [{ id: 'p1', field: 'ServiceName', op: '=', value: 'api-gateway' }],
    };
    const conditions = buildTraceWhereConditions(otelConfig, filters);
    expect(conditions.some((c) => c.includes('ServiceName') && c.includes('api-gateway'))).toBe(true);
  });
});

describe('buildTraceDetailQuery', () => {
  it('returns empty string when traceId is unmapped', () => {
    expect(buildTraceDetailQuery(noTraceIdConfig, 'abc')).toBe('');
  });

  it('bounds the scan using the trace_id_ts materialized view by default', () => {
    const sql = buildTraceDetailQuery(otelConfig, 'abc123');
    expect(sql).toContain('otel_traces_trace_id_ts');
    expect(sql).toContain("SELECT min(Start) FROM");
    expect(sql).toContain("SELECT max(End) FROM");
  });

  it('pads the upper bound by 1 second to cover the trace_id_ts End column\'s second-precision truncation', () => {
    // otel_traces_trace_id_ts.End is `DateTime` (second precision) even though it's populated via
    // max(Timestamp) over a DateTime64(9) column, so any span after :00 within that final second
    // would be wrongly excluded by a bare `Timestamp <= End` — verified live against ClickHouse.
    const sql = buildTraceDetailQuery(otelConfig, 'abc123');
    expect(sql).toContain('+ INTERVAL 1 SECOND');
  });

  it('omits the MV bound when useTraceIdIndex is false, still LIMIT-bounded', () => {
    const sql = buildTraceDetailQuery(otelConfig, 'abc123', { useTraceIdIndex: false });
    expect(sql).not.toContain('trace_id_ts');
    expect(sql).toMatch(/LIMIT \d+/);
  });

  it('applies a default LIMIT and a custom limit when provided', () => {
    const sqlDefault = buildTraceDetailQuery(otelConfig, 'abc123');
    expect(sqlDefault).toContain('LIMIT 10000');
    const sqlCustom = buildTraceDetailQuery(otelConfig, 'abc123', { limit: 500 });
    expect(sqlCustom).toContain('LIMIT 500');
  });

  it('selects Events.* and Links.* nested OTel columns unconditionally', () => {
    const sql = buildTraceDetailQuery(otelConfig, 'abc123');
    expect(sql).toContain('arrayMap(x -> toUnixTimestamp64Nano(x), Events.Timestamp) AS eventsTimestamp');
    expect(sql).toContain('Events.Name AS eventsName');
    expect(sql).toContain('Events.Attributes AS eventsAttributes');
    expect(sql).toContain('Links.TraceId AS linksTraceId');
    expect(sql).toContain('Links.SpanId AS linksSpanId');
    expect(sql).toContain('Links.Attributes AS linksAttributes');
  });

  it('degrades gracefully (no "undefined") when parentSpanId/serviceName/spanKind/statusMessage/timestamp/duration/attrs are unmapped', () => {
    const cfg: SourceConfig = {
      ...otelConfig,
      columns: {
        ...OTEL_COLUMN_MAPPING,
        parentSpanId: '',
        serviceName: '',
        spanKind: '',
        statusMessage: '',
        timestamp: '',
        duration: '',
        spanAttributes: '',
        resourceAttributes: '',
      },
    };
    const sql = buildTraceDetailQuery(cfg, 'abc');
    expect(sql).not.toContain('undefined');
    expect(sql).toContain("'' AS parentSpanId");
    expect(sql).toContain("'' AS serviceName");
    expect(sql).toContain("'' AS spanKind");
    expect(sql).toContain("'' AS statusMessage");
    expect(sql).toContain('0 AS startNs');
    expect(sql).toContain('0 AS durationNs');
    expect(sql).toContain('map() AS attributes');
    expect(sql).toContain('map() AS resourceAttributes');
    // Without a mapped timestamp, the MV bound conditions (which reference c.timestamp) must be
    // dropped rather than compare against an empty column reference.
    expect(sql).not.toContain(' >= (SELECT min(Start)');
  });
});

describe('buildTraceVolumeQuery', () => {
  it('returns empty string when timestamp is unmapped', () => {
    const cfg: SourceConfig = { ...otelConfig, columns: { ...OTEL_COLUMN_MAPPING, timestamp: '' } };
    const sql = buildTraceVolumeQuery(cfg, DEFAULT_TRACE_LIST_FILTERS, {
      interval: { macro: true },
      breakdown: { kind: 'none' },
    });
    expect(sql).toBe('');
  });

  it('buckets by the traces table with a status breakdown', () => {
    const sql = buildTraceVolumeQuery(otelConfig, DEFAULT_TRACE_LIST_FILTERS, {
      interval: { unit: 'MINUTE', value: 5 },
      breakdown: { kind: 'severity', expr: otelConfig.columns.statusCode },
    });
    expect(sql).toContain('FROM "default"."otel_traces"');
    expect(sql).toContain('toStartOfInterval(Timestamp, INTERVAL 5 MINUTE)');
    expect(sql).toContain('toString(StatusCode)');
    expect(sql).not.toContain('lower(');
  });

  it('buckets by service with top-N + Other breakdown', () => {
    const sql = buildTraceVolumeQuery(otelConfig, DEFAULT_TRACE_LIST_FILTERS, {
      interval: { macro: true },
      breakdown: { kind: 'field', expr: otelConfig.columns.serviceName, limit: 5 },
    });
    expect(sql).toContain('WITH top AS');
    expect(sql).toContain('LIMIT 5');
    expect(sql).toContain("'Other'");
  });
});
