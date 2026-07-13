-- Fixture tables for grading the "Guess with AI" column-mapping assist (see
-- src/ai/columnGuess.eval.ts). Each table probes a harder naming scheme than the last; the gold
-- (correct) mapping for each is documented here AND mirrored in columnGuess.eval.ts (single
-- source of truth for scoring — keep both in sync if you touch either).
--
-- These only need a handful of rows: the guesser reads name+type from system.columns, not row
-- data, so row content isn't load-bearing for the eval itself — seeded anyway for realism and so
-- the tables show up naturally when browsing the datasource.

-- L1 — exact OpenTelemetry column names. Must be a 100% guess (it's the few-shot example itself).
-- Gold: timestamp=Timestamp, body=Body, severity=SeverityText, serviceName=ServiceName, traceId=TraceId
CREATE TABLE IF NOT EXISTS default.eval_otel (
    Timestamp    DateTime64(9, 'UTC'),
    Body         String,
    SeverityText LowCardinality(String),
    ServiceName  LowCardinality(String),
    TraceId      String
) ENGINE = MergeTree() ORDER BY Timestamp;

INSERT INTO default.eval_otel (Timestamp, Body, SeverityText, ServiceName, TraceId)
SELECT toDateTime64(addSeconds(now(), -number), 9), concat('event ', toString(number)), 'INFO', 'checkout-service', lower(hex(rand64(number)))
FROM numbers(20);

-- L2 — conventional lowercase/common names, not OTel vocabulary.
-- Gold: timestamp=timestamp, body=message, severity=level, serviceName=service, traceId=trace_id
CREATE TABLE IF NOT EXISTS default.eval_common (
    timestamp DateTime,
    message   String,
    level     LowCardinality(String),
    service   LowCardinality(String),
    trace_id  String
) ENGINE = MergeTree() ORDER BY timestamp;

INSERT INTO default.eval_common (timestamp, message, level, service, trace_id)
SELECT addSeconds(now(), -number), concat('log line ', toString(number)), 'info', 'billing-service', lower(hex(rand64(number)))
FROM numbers(20);

-- L3 — terse abbreviations.
-- Gold: timestamp=ts, body=msg, severity=lvl, serviceName=svc, traceId=tid
CREATE TABLE IF NOT EXISTS default.eval_abbrev (
    ts  DateTime,
    msg String,
    lvl LowCardinality(String),
    svc LowCardinality(String),
    tid String
) ENGINE = MergeTree() ORDER BY ts;

INSERT INTO default.eval_abbrev (ts, msg, lvl, svc, tid)
SELECT addSeconds(now(), -number), concat('m', toString(number)), 'info', 'inventory-svc', lower(hex(rand64(number)))
FROM numbers(20);

-- L4 — correct columns plus plausible decoys, to test disambiguation rather than name-matching.
-- Gold: timestamp=event_time, body=body, severity=severity_level, serviceName=service, traceId=trace_id
-- Decoys (must NOT be picked): created_at, updated_at, raw_line, status, user_id, host, region
CREATE TABLE IF NOT EXISTS default.eval_noisy (
    event_time     DateTime,
    created_at     DateTime,
    updated_at     DateTime,
    body           String,
    raw_line       String,
    severity_level LowCardinality(String),
    status         LowCardinality(String),
    service        LowCardinality(String),
    user_id        String,
    host           String,
    region         LowCardinality(String),
    trace_id       String
) ENGINE = MergeTree() ORDER BY event_time;

INSERT INTO default.eval_noisy
    (event_time, created_at, updated_at, body, raw_line, severity_level, status, service, user_id, host, region, trace_id)
SELECT
    addSeconds(now(), -number), addSeconds(now(), -number - 5), addSeconds(now(), -number + 5),
    concat('request handled ', toString(number)), concat('raw:', toString(number)),
    'info', 'ok', 'search-service', toString(1000 + number), concat('host-', toString(number % 10)), 'us-east-1',
    lower(hex(rand64(number)))
FROM numbers(20);

-- L5 — adversarial: cryptic/non-English names, a decoy, and a Map column as noise.
-- Gold: timestamp=col_a, body=pesan, severity=f1, serviceName=svc_tag, traceId=tr_ref
-- Decoy (must NOT be picked as timestamp): updated_at. `attrs` is a Map — not a valid target for
-- any single-column field here, so any mapping pointing at it is also a miss.
-- Expected: best-effort/partial credit — this level exists to prove the hallucination guard holds
-- and nothing crashes, not that every field is guessed correctly.
CREATE TABLE IF NOT EXISTS default.eval_adversarial (
    col_a      DateTime,
    updated_at DateTime,
    pesan      String,
    f1         LowCardinality(String),
    svc_tag    LowCardinality(String),
    tr_ref     String,
    attrs      Map(LowCardinality(String), String)
) ENGINE = MergeTree() ORDER BY col_a;

INSERT INTO default.eval_adversarial (col_a, updated_at, pesan, f1, svc_tag, tr_ref, attrs)
SELECT
    addSeconds(now(), -number), addSeconds(now(), -number + 5),
    concat('pesan nomor ', toString(number)), 'info', 'notif-svc', lower(hex(rand64(number))),
    map('k', toString(number))
FROM numbers(20);
