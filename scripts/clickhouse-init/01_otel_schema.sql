-- OTel-compatible logs table (matches grafana-clickhouse-datasource OTel v1 schema)
CREATE TABLE IF NOT EXISTS default.otel_logs (
    Timestamp         DateTime64(9, 'UTC') CODEC(Delta, ZSTD(1)),
    TimestampTime     DateTime DEFAULT toDateTime(Timestamp),
    TraceId           String   CODEC(ZSTD(1)),
    SpanId            String   CODEC(ZSTD(1)),
    TraceFlags        UInt32   DEFAULT 0,
    SeverityText      LowCardinality(String) CODEC(ZSTD(1)),
    SeverityNumber    Int32    DEFAULT 0,
    ServiceName       LowCardinality(String) CODEC(ZSTD(1)),
    Body              String   CODEC(ZSTD(1)),
    ResourceSchemaUrl String   CODEC(ZSTD(1)),
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ScopeSchemaUrl    String   CODEC(ZSTD(1)),
    ScopeName         String   CODEC(ZSTD(1)),
    ScopeVersion      String   CODEC(ZSTD(1)),
    ScopeAttributes   Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    LogAttributes     Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    INDEX idx_body Body TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 8
) ENGINE = MergeTree()
PARTITION BY toDate(TimestampTime)
ORDER BY (ServiceName, TimestampTime, Timestamp)
TTL TimestampTime + INTERVAL 30 DAY;

-- OTel-compatible traces table
CREATE TABLE IF NOT EXISTS default.otel_traces (
    Timestamp         DateTime64(9, 'UTC') CODEC(Delta, ZSTD(1)),
    TimestampTime     DateTime DEFAULT toDateTime(Timestamp),
    TraceId           String   CODEC(ZSTD(1)),
    SpanId            String   CODEC(ZSTD(1)),
    ParentSpanId      String   CODEC(ZSTD(1)),
    TraceState        String   CODEC(ZSTD(1)),
    SpanName          LowCardinality(String) CODEC(ZSTD(1)),
    SpanKind          LowCardinality(String) CODEC(ZSTD(1)),
    ServiceName       LowCardinality(String) CODEC(ZSTD(1)),
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ScopeName         String   CODEC(ZSTD(1)),
    ScopeVersion      String   CODEC(ZSTD(1)),
    SpanAttributes    Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    Duration          Int64    CODEC(ZSTD(1)),
    StatusCode        LowCardinality(String) CODEC(ZSTD(1)),
    StatusMessage     String   CODEC(ZSTD(1)),
    Events            Nested (
        Timestamp     DateTime64(9, 'UTC'),
        Name          LowCardinality(String),
        Attributes    Map(LowCardinality(String), String)
    ),
    Links             Nested (
        TraceId       String,
        SpanId        String,
        TraceState    String,
        Attributes    Map(LowCardinality(String), String)
    )
) ENGINE = MergeTree()
PARTITION BY toDate(TimestampTime)
ORDER BY (ServiceName, SpanName, toUnixTimestamp(Timestamp), TraceId)
TTL TimestampTime + INTERVAL 30 DAY;
