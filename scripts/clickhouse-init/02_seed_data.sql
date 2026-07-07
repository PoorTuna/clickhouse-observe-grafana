-- Seed sample OTel logs (2000 rows spanning last ~100 minutes)
INSERT INTO default.otel_logs
    (Timestamp, TraceId, SpanId, SeverityText, SeverityNumber, ServiceName, Body, ResourceAttributes, LogAttributes, Payload)
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
        'k8s.namespace.name', 'production',
        'k8s.pod.name',    concat('pod-', toString(number % 20))
    )                                                           AS ResourceAttributes,
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

-- Seed sample OTel traces (100 traces, 5 spans each with realistic nested timing)
--
-- Span layout per trace (span_num):
--   0 = root HTTP span (CLIENT)    starts at T+0,  duration = full trace ~500-1400ms
--   1 = auth check (INTERNAL)      starts at T+10ms, duration ~50-200ms
--   2 = DB query (CLIENT)          starts at T+70ms, duration ~100-600ms
--   3 = cache lookup (INTERNAL)    starts at T+80ms, duration ~20-100ms (inside DB span)
--   4 = downstream HTTP (CLIENT)   starts at T+200ms, duration ~150-500ms
--
-- Durations are varied per trace via (number % N) expressions.
-- StatusCode is per-span (leaf spans occasionally error), not per-trace.

INSERT INTO default.otel_traces
    (Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind,
     ServiceName, ResourceAttributes, SpanAttributes, Duration, StatusCode)
SELECT
    -- Root starts first; each child offset into the root's window
    toDateTime64(
        addSeconds(now(), -(toInt64(number) * 30)) +
        toIntervalMillisecond(
            multiIf(
                span_num = 0, 0,
                span_num = 1, 10,
                span_num = 2, 70,
                span_num = 3, 80,
                200
            )
        ),
        9
    ) AS Timestamp,

    lower(hex(farmHash64(number)))                                              AS TraceId,
    lower(hex(farmHash64(number * 10 + span_num)))                             AS SpanId,

    -- Root has no parent; each child's parent is the preceding span
    if(span_num = 0, '',
       lower(hex(farmHash64(number * 10 + span_num - 1))))                     AS ParentSpanId,

    ['HTTP GET /orders','authCheck','SELECT FROM orders','cacheGet','HTTP POST /payment'][1 + (span_num % 5)] AS SpanName,
    ['SERVER','INTERNAL','CLIENT','INTERNAL','CLIENT'][1 + (span_num % 5)]    AS SpanKind,

    ['order-service','auth-service','order-service','order-service','payment-gateway'][1 + (span_num % 5)] AS ServiceName,

    map('service.name',
        ['order-service','auth-service','order-service','order-service','payment-gateway'][1 + (span_num % 5)]
    )                                                                           AS ResourceAttributes,

    map('db.system',       if(span_num IN (2,3), 'clickhouse', ''),
        'http.status_code', toString(if((number + span_num) % 13 = 0, 500, 200)))
                                                                                AS SpanAttributes,

    -- Root covers full trace; children are progressively shorter
    toInt64(
        multiIf(
            span_num = 0, (500 + (number % 900)) * 1000000,       -- 500ms–1400ms
            span_num = 1, (50  + (number % 150)) * 1000000,       -- 50ms–200ms
            span_num = 2, (100 + (number % 500)) * 1000000,       -- 100ms–600ms
            span_num = 3, (20  + (number % 80))  * 1000000,       -- 20ms–100ms
                          (150 + (number % 350)) * 1000000        -- 150ms–500ms
        )
    )                                                                           AS Duration,

    if((number + span_num) % 13 = 0, 'STATUS_CODE_ERROR', 'STATUS_CODE_OK')   AS StatusCode

FROM numbers(100) AS t
CROSS JOIN (SELECT number AS span_num FROM numbers(5)) AS s;
