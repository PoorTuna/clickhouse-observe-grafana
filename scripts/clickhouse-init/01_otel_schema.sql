-- Native ClickHouse JSON type — GA as of 25.3. This dev stack pins to 26.3 (matching the user's
-- real deployment), so the experimental flag below is a no-op safety net, not a requirement.
SET allow_experimental_json_type = 1;

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
    -- Native JSON column, not part of the standard OTel exporter schema — added to exercise the
    -- plugin's JSON-path field discovery (FieldsContext Phase C) against real dev data.
    -- `user.id` is type-hinted (always UInt32); every other path is inferred dynamically, so the
    -- seed exercises both the type-hinted and dynamic-path discovery branches.
    Payload           JSON(user.id UInt32),
    INDEX idx_body Body TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 8
) ENGINE = MergeTree()
PARTITION BY toDate(TimestampTime)
ORDER BY (ServiceName, TimestampTime, Timestamp)
TTL TimestampTime + INTERVAL 30 DAY;
