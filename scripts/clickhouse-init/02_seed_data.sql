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
