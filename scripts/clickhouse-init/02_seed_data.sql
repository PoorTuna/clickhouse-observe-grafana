-- Seed sample OTel logs (2000 rows spanning last ~100 minutes)
INSERT INTO default.otel_logs
    (Timestamp, TraceId, SpanId, SeverityText, SeverityNumber, ServiceName, Body, ResourceAttributes, ScopeAttributes, LogAttributes, Payload)
SELECT
    toDateTime64(addSeconds(now(), -(toInt64(number) * 3)), 9) AS Timestamp,
    lower(hex(rand64(number)))                                  AS TraceId,
    lower(hex(rand32(number)))                                  AS SpanId,
    multiIf(number % 20 = 0, 'ERROR',
            number % 50 = 0, 'CRITICAL',
            number % 7  = 0, 'WARN',
            number % 3  = 0, 'DEBUG',
            'INFO')                                             AS SeverityText,
    0                                                           AS SeverityNumber,
    ['payment-gateway','order-service','catalog-api','auth-service','cart-service'][1 + (number % 5)] AS ServiceName,
    concat(
        multiIf(number % 20 = 0, 'ERROR: ', number % 7 = 0, 'WARN: ', 'INFO: '),
        ['Processing payment','Order created','Cache hit','DB query executed','Health check OK',
         'Background job started','Connection established','Request received','Response sent',
         'Token validated','Session expired','Retry attempt','Circuit breaker open'][1 + (number % 13)],
        ' req-', toString(number)
    )                                                           AS Body,
    map(
        'service.name',    ['payment-gateway','order-service','catalog-api','auth-service','cart-service'][1 + (number % 5)],
        'service.version', concat('1.', toString(number % 4), '.', toString(number % 10)),
        'k8s.namespace.name', ['production','staging','dev'][1 + (number % 3)],
        'k8s.pod.name',    concat('pod-', toString(number % 20))
    )                                                           AS ResourceAttributes,
    map(
        'deployment.environment', ['production','staging'][1 + (number % 2)]
    )                                                           AS ScopeAttributes,
    map(
        'http.method',      ['GET','POST','PUT','DELETE'][1 + (number % 4)],
        'http.status_code', toString(if(number % 20 = 0, 500, if(number % 15 = 0, 404, 200))),
        'http.url',         concat('/api/v1/', ['orders','products','users','auth','cart'][1 + (number % 5)])
    )                                                           AS LogAttributes,
    -- Native JSON payload, not part of the OTel exporter schema — seeded to exercise field
    -- discovery over a JSON column: user.id is type-hinted (see schema), everything else is a
    -- dynamic path. request.tags/flags.debug/request.duration_ms are only present on a subset of
    -- rows on purpose, so path discovery has to cope with sparsity like it does for Map keys.
    concat(
        '{"user":{"id":', toString(1000 + (number % 500)),
        ',"name":"', ['alice','bob','carol','dave','erin'][1 + (number % 5)], '"}',
        ',"request":{"method":"', ['GET','POST','PUT','DELETE'][1 + (number % 4)], '"',
        if(number % 3 = 0, concat(',"duration_ms":', toString(5 + (number % 500))), ''),
        if(number % 4 = 0, concat(',"tags":["', ['beta','internal','retry'][1 + (number % 3)], '"]'), ''),
        '}',
        if(number % 5 = 0, ',"flags":{"debug":true}', ''),
        '}'
    )                                                           AS Payload
FROM numbers(2000);

-- Seed matching traces for every seeded log row. Pulled directly from the otel_logs rows just
-- inserted above (TraceId/SpanId/ServiceName copied verbatim) rather than recomputed via rand64/
-- rand32 with the "same" argument — those functions' argument is only a subexpression-elimination
-- guard, not a seed, so two separate INSERT ... SELECT statements produce unrelated values even
-- when given the same `number`. Selecting from the table itself is the only way to guarantee the
-- TraceId actually matches, which is what makes the log detail drawer's trace link resolve to a
-- real trace instead of "No data". Safe to run right after the otel_logs insert on a fresh volume
-- (this script only runs once, via docker-entrypoint-initdb.d, against an empty table).
-- Root span: server-side request, ServiceName matches the log row's.
INSERT INTO default.otel_traces
    (Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, ResourceAttributes, SpanAttributes, Duration, StatusCode, StatusMessage)
SELECT
    Timestamp,
    TraceId,
    SpanId,
    ''                                                           AS ParentSpanId,
    multiIf(ServiceName = 'payment-gateway', 'ProcessPayment',
            ServiceName = 'order-service',   'ProcessOrder',
            ServiceName = 'catalog-api',     'QueryCatalog',
            ServiceName = 'auth-service',    'ValidateToken',
            'HandleCartRequest')                                 AS SpanName,
    'SPAN_KIND_SERVER'                                          AS SpanKind,
    ServiceName,
    ResourceAttributes,
    map('http.method', LogAttributes['http.method'])            AS SpanAttributes,
    toUInt64(5_000_000 + (sipHash64(SpanId) % 500) * 1_000_000) AS Duration, -- ns: 5-505ms
    if(SeverityText IN ('ERROR', 'CRITICAL'), 'STATUS_CODE_ERROR', 'STATUS_CODE_OK') AS StatusCode,
    if(SeverityText IN ('ERROR', 'CRITICAL'), 'internal error', '') AS StatusMessage
FROM default.otel_logs;

-- Child span: a downstream call the root span makes, so the trace waterfall in Explore shows
-- more than a single bar. ParentSpanId references the root span's SpanId (= the log row's SpanId).
INSERT INTO default.otel_traces
    (Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, SpanAttributes, Duration, StatusCode)
SELECT
    Timestamp + INTERVAL 1 MILLISECOND,
    TraceId,
    lower(hex(sipHash128(SpanId, 'child')))                     AS SpanId,
    SpanId                                                      AS ParentSpanId,
    ['DB Query', 'Cache Lookup', 'External API Call'][1 + (sipHash64(SpanId) % 3)] AS SpanName,
    'SPAN_KIND_CLIENT'                                          AS SpanKind,
    ['postgres', 'redis', 'payment-provider'][1 + (sipHash64(SpanId) % 3)] AS ServiceName,
    map()                                                       AS SpanAttributes,
    toUInt64(1_000_000 + (sipHash64(SpanId) % 200) * 500_000)   AS Duration, -- ns: 1-101ms
    'STATUS_CODE_OK'                                            AS StatusCode
FROM default.otel_logs;
