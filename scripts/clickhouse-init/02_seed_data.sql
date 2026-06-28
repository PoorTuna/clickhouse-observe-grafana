-- Seed sample OTel logs (2000 rows spanning last ~100 minutes)
INSERT INTO default.otel_logs
    (Timestamp, TraceId, SpanId, SeverityText, SeverityNumber, ServiceName, Body, ResourceAttributes, LogAttributes)
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
    )                                                           AS LogAttributes
FROM numbers(2000);

-- Seed sample OTel traces (100 traces, 5 spans each)
INSERT INTO default.otel_traces
    (Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind,
     ServiceName, ResourceAttributes, SpanAttributes, Duration, StatusCode)
SELECT
    toDateTime64(addSeconds(now(), -(toInt64(number) * 30 + toInt64(span_num))), 9) AS Timestamp,
    lower(hex(farmHash64(number)))                                                   AS TraceId,
    lower(hex(farmHash64(number * 10 + span_num)))                                  AS SpanId,
    if(span_num = 0, '', lower(hex(farmHash64(number * 10 + span_num - 1))))        AS ParentSpanId,
    ['HTTP GET /orders','SELECT FROM orders','publishMessage','cacheGet','HTTP POST /payment'][span_num % 5] AS SpanName,
    ['SERVER','CLIENT','PRODUCER','CONSUMER','INTERNAL'][span_num % 5]              AS SpanKind,
    ['order-service','payment-gateway','catalog-api'][number % 3]                   AS ServiceName,
    map('service.name', ['order-service','payment-gateway','catalog-api'][number % 3]) AS ResourceAttributes,
    map('db.system', 'clickhouse', 'http.status_code', toString(if(number % 20 = 0, 500, 200))) AS SpanAttributes,
    toInt64(100 + number % 900) * 1000000                                           AS Duration,
    if(number % 20 = 0, 'STATUS_CODE_ERROR', 'STATUS_CODE_OK')                     AS StatusCode
FROM numbers(100) AS t
CROSS JOIN (SELECT number AS span_num FROM numbers(5)) AS s;
