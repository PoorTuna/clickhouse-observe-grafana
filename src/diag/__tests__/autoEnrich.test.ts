import { EMPTY_COLUMN_MAPPING, SourceConfig } from '../../types';
import { __resetForTests as resetTracer, startAction } from '../tracer';
import { __resetForTests as resetAutoEnrich, startAutoEnrichment } from '../autoEnrich';
import { setEnrichmentEnabled } from '../enrichment';
import { fetchServerStats } from '../serverStats';

jest.mock('../serverStats', () => ({
  fetchServerStats: jest.fn(),
}));

const mockFetchServerStats = fetchServerStats as jest.Mock;

const config: SourceConfig = {
  datasourceUid: 'ds-1',
  database: 'default',
  logsTable: 't',
  isOtel: false,
  columns: { ...EMPTY_COLUMN_MAPPING },
};

const BATCH_DEBOUNCE_MS = 500;
const POLL_ROUND_DELAYS_MS = [1000, 3000, 8000];

beforeEach(() => {
  resetTracer();
  resetAutoEnrich();
  mockFetchServerStats.mockReset();
  setEnrichmentEnabled(false);
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

/** Advances past the batch debounce, letting a queued flush actually start. */
async function advancePastDebounce(): Promise<void> {
  await jest.advanceTimersByTimeAsync(BATCH_DEBOUNCE_MS);
}

/** Advances through every poll round's backoff delay, letting each round's mocked lookup resolve
 *  in between. */
async function advanceAllRounds(): Promise<void> {
  for (const delay of POLL_ROUND_DELAYS_MS) {
    await jest.advanceTimersByTimeAsync(delay);
  }
}

describe('startAutoEnrichment', () => {
  it('does nothing when enrichment is disabled, but stamps the root not-tagged', async () => {
    startAutoEnrichment(() => ({ datasourceUid: 'ds-1', config }));
    const action = startAction('a');
    action.end('ok');
    await advancePastDebounce();
    expect(mockFetchServerStats).not.toHaveBeenCalled();
    // Regression: this root's queries never carried a log_comment (enrichment was off when they
    // ran), so no lookup will ever find them — even if the toggle is enabled later. Leaving the
    // attr unset made this indistinguishable from "a lookup just hasn't resolved yet" in
    // StatsTable, which then showed "waiting to flush" forever. See StatsTable.tsx.
    expect(action.span.attrs.serverStatsStatus).toBe('not-tagged');
  });

  it('stamps not-tagged when the context getter returns undefined (e.g. no datasource configured yet)', async () => {
    setEnrichmentEnabled(true);
    startAutoEnrichment(() => undefined);
    const action = startAction('a');
    action.end('ok');
    await advancePastDebounce();
    expect(mockFetchServerStats).not.toHaveBeenCalled();
    expect(action.span.attrs.serverStatsStatus).toBe('not-tagged');
  });

  it('stamps pending synchronously when a root joins the batch, before any lookup resolves', async () => {
    setEnrichmentEnabled(true);
    startAutoEnrichment(() => ({ datasourceUid: 'ds-1', config }));
    mockFetchServerStats.mockResolvedValue({ status: 'no-data' });

    const action = startAction('a');
    action.end('ok');
    expect(action.span.attrs.serverStatsStatus).toBe('pending');

    await advancePastDebounce();
    await advanceAllRounds();
    expect(action.span.attrs.serverStatsStatus).toBe('no-data');
  });

  it('fetches stats for the root and applies matching rows to query spans by spanId', async () => {
    setEnrichmentEnabled(true);
    startAutoEnrichment(() => ({ datasourceUid: 'ds-1', config }));

    const action = startAction('Search submit');
    const logs = action.child('logs', 'logs');
    mockFetchServerStats.mockResolvedValueOnce({
      status: 'ok',
      rows: [
        {
          traceId: action.span.id,
          spanId: logs.span.id,
          queryId: 'q-1',
          type: 'QueryFinish',
          queryDurationMs: 840,
          readRows: 12400000,
          readBytes: 1,
          resultRows: 100,
          memoryUsage: 1,
        },
      ],
    });
    logs.end('ok');
    action.end('ok');
    await advancePastDebounce();
    await jest.advanceTimersByTimeAsync(POLL_ROUND_DELAYS_MS[0]);

    expect(mockFetchServerStats).toHaveBeenCalledWith('ds-1', config, [action.span.id], expect.any(AbortSignal));
    expect(logs.span.attrs.serverDurationMs).toBe(840);
    expect(logs.span.attrs.serverReadRows).toBe(12400000);
    expect(action.span.attrs.serverStatsStatus).toBe('ok');
  });

  it('does not attach server attrs to a span with no matching row', async () => {
    setEnrichmentEnabled(true);
    startAutoEnrichment(() => ({ datasourceUid: 'ds-1', config }));

    const action = startAction('a');
    const logs = action.child('logs', 'logs');
    mockFetchServerStats.mockResolvedValue({ status: 'ok', rows: [] });
    logs.end('ok');
    action.end('ok');
    await advancePastDebounce();
    await advanceAllRounds();

    expect(logs.span.attrs.serverDurationMs).toBeUndefined();
  });

  it('records a no-data result on the root without touching child spans', async () => {
    setEnrichmentEnabled(true);
    startAutoEnrichment(() => ({ datasourceUid: 'ds-1', config }));

    const action = startAction('a');
    mockFetchServerStats.mockResolvedValue({ status: 'no-data' });
    action.end('ok');
    await advancePastDebounce();
    await advanceAllRounds();

    expect(action.span.attrs.serverStatsStatus).toBe('no-data');
  });

  it('records an unavailable result with its reason and detail on the root, and stops polling', async () => {
    setEnrichmentEnabled(true);
    startAutoEnrichment(() => ({ datasourceUid: 'ds-1', config }));

    const action = startAction('a');
    mockFetchServerStats.mockResolvedValue({ status: 'unavailable', reason: 'no-grant', detail: 'Not enough privileges' });
    action.end('ok');
    await advancePastDebounce();
    await jest.advanceTimersByTimeAsync(POLL_ROUND_DELAYS_MS[0]);

    expect(action.span.attrs).toMatchObject({
      serverStatsStatus: 'unavailable',
      serverStatsReason: 'no-grant',
      serverStatsDetail: 'Not enough privileges',
    });
    // Definite error — no retry (a permission failure won't fix itself between rounds).
    expect(mockFetchServerStats).toHaveBeenCalledTimes(1);
  });

  // B3: the whole point of batching — several roots ending within the debounce window must share
  // ONE lookup, not one each. Before this fix an auto-refresh tick alone could fire ~18 separate
  // system.query_log scans.
  it('coalesces multiple roots ending within the debounce window into a single lookup', async () => {
    setEnrichmentEnabled(true);
    startAutoEnrichment(() => ({ datasourceUid: 'ds-1', config }));
    mockFetchServerStats.mockResolvedValue({ status: 'no-data' });

    const a1 = startAction('Auto-refresh');
    a1.end('ok');
    const a2 = startAction('volume');
    a2.end('ok');
    const a3 = startAction('logs');
    a3.end('ok');

    await advancePastDebounce();
    await jest.advanceTimersByTimeAsync(POLL_ROUND_DELAYS_MS[0]);

    expect(mockFetchServerStats).toHaveBeenCalledTimes(1);
    expect(mockFetchServerStats.mock.calls[0][2].sort()).toEqual([a1.span.id, a2.span.id, a3.span.id].sort());
  });

  // B5: system.query_log flushes per-query, so a fast round can match some of an action's queries
  // and not others. The batch must keep polling that root across rounds until every query span is
  // matched or rounds run out — not stop the moment any single row arrives.
  it('keeps polling a root across rounds until every one of its query spans is matched', async () => {
    setEnrichmentEnabled(true);
    startAutoEnrichment(() => ({ datasourceUid: 'ds-1', config }));

    const action = startAction('a');
    const logs = action.child('logs', 'logs');
    logs.setAttrs({ sql: 'SELECT 1' });
    const volume = action.child('volume', 'volume');
    volume.setAttrs({ sql: 'SELECT 2' });
    logs.end('ok');
    volume.end('ok');
    action.end('ok');

    mockFetchServerStats
      .mockResolvedValueOnce({
        status: 'ok',
        rows: [
          {
            traceId: action.span.id,
            spanId: logs.span.id,
            queryId: 'q-1',
            type: 'QueryFinish',
            queryDurationMs: 10,
            readRows: 1,
            readBytes: 1,
            resultRows: 1,
            memoryUsage: 1,
          },
        ],
      })
      .mockResolvedValueOnce({
        status: 'ok',
        rows: [
          {
            traceId: action.span.id,
            spanId: volume.span.id,
            queryId: 'q-2',
            type: 'QueryFinish',
            queryDurationMs: 20,
            readRows: 2,
            readBytes: 2,
            resultRows: 2,
            memoryUsage: 2,
          },
        ],
      });

    await advancePastDebounce();
    await jest.advanceTimersByTimeAsync(POLL_ROUND_DELAYS_MS[0]);
    expect(logs.span.attrs.serverDurationMs).toBe(10);
    expect(volume.span.attrs.serverDurationMs).toBeUndefined();
    expect(action.span.attrs.serverStatsStatus).toBe('ok'); // partial data already arrived

    await jest.advanceTimersByTimeAsync(POLL_ROUND_DELAYS_MS[1]);
    expect(volume.span.attrs.serverDurationMs).toBe(20);
    expect(mockFetchServerStats).toHaveBeenCalledTimes(2);
  });

  it('stops polling a root early once every one of its query spans is matched (does not wait out every round)', async () => {
    setEnrichmentEnabled(true);
    startAutoEnrichment(() => ({ datasourceUid: 'ds-1', config }));

    const action = startAction('a');
    const logs = action.child('logs', 'logs');
    logs.setAttrs({ sql: 'SELECT 1' });
    logs.end('ok');
    action.end('ok');

    mockFetchServerStats.mockResolvedValueOnce({
      status: 'ok',
      rows: [
        {
          traceId: action.span.id,
          spanId: logs.span.id,
          queryId: 'q-1',
          type: 'QueryFinish',
          queryDurationMs: 10,
          readRows: 1,
          readBytes: 1,
          resultRows: 1,
          memoryUsage: 1,
        },
      ],
    });

    await advancePastDebounce();
    await jest.advanceTimersByTimeAsync(POLL_ROUND_DELAYS_MS[0]);
    await advanceAllRounds(); // exhaust every remaining round's delay, if any were still scheduled

    expect(mockFetchServerStats).toHaveBeenCalledTimes(1); // fully matched after round 1 — no round 2
  });
});

// The plan's waterfall model always showed a query span breaking down into transport/clickhouse/
// decode children (see the diagnostics plan's "The model" section) — this was never actually built
// in Phase 1 (single flat span per query) and stayed missing even after Phase 2 landed the
// query_duration_ms needed to reconstruct it. Caught live: clicking a "logs" entry showed one flat
// bar with no breakdown at all.
describe('transport/clickhouse split reconstruction', () => {
  it('adds transport and clickhouse children sized from query_duration_ms, ending where decode starts', async () => {
    setEnrichmentEnabled(true);
    startAutoEnrichment(() => ({ datasourceUid: 'ds-1', config }));

    const action = startAction('a');
    const logs = action.child('logs', 'logs');
    // Simulate runQuery.ts's real decode child: logs span runs [0,1000] (relative), decode is the
    // last 60ms of it.
    Object.assign(logs.span, { startMs: 0, endMs: 1000 });
    const decode = logs.child('decode', 'decode');
    Object.assign(decode.span, { startMs: 940, endMs: 1000 });
    decode.end('ok');

    mockFetchServerStats.mockResolvedValueOnce({
      status: 'ok',
      rows: [
        {
          traceId: action.span.id,
          spanId: logs.span.id,
          queryId: 'q-1',
          type: 'QueryFinish',
          queryDurationMs: 840,
          readRows: 100,
          readBytes: 1,
          resultRows: 10,
          memoryUsage: 1,
        },
      ],
    });
    action.end('ok');
    await advancePastDebounce();
    await jest.advanceTimersByTimeAsync(POLL_ROUND_DELAYS_MS[0]);

    const kinds = logs.span.children.map((c) => c.kind);
    expect(kinds).toEqual(['decode', 'transport', 'clickhouse']);

    const clickhouse = logs.span.children.find((c) => c.kind === 'clickhouse')!;
    const transport = logs.span.children.find((c) => c.kind === 'transport')!;
    // clickhouse ends exactly where decode starts (940), sized to query_duration_ms (840) — so it
    // starts at 100.
    expect(clickhouse.endMs).toBe(940);
    expect(clickhouse.startMs).toBe(100);
    expect(clickhouse.attrs.readRows).toBe(100);
    // transport fills whatever's left at the front: [0, 100].
    expect(transport.startMs).toBe(0);
    expect(transport.endMs).toBe(100);
  });

  it('clamps clickhouse to the available window instead of producing a negative transport', async () => {
    setEnrichmentEnabled(true);
    startAutoEnrichment(() => ({ datasourceUid: 'ds-1', config }));

    const action = startAction('a');
    const logs = action.child('logs', 'logs');
    Object.assign(logs.span, { startMs: 0, endMs: 100 }); // no decode child this time

    mockFetchServerStats.mockResolvedValueOnce({
      status: 'ok',
      // query_duration_ms (840) overshoots the span's own measured window (100) — clock skew
      // between the browser and ClickHouse is expected, not a bug to crash on.
      rows: [
        {
          traceId: action.span.id,
          spanId: logs.span.id,
          queryId: 'q-1',
          type: 'QueryFinish',
          queryDurationMs: 840,
          readRows: 1,
          readBytes: 1,
          resultRows: 1,
          memoryUsage: 1,
        },
      ],
    });
    action.end('ok');
    await advancePastDebounce();
    await jest.advanceTimersByTimeAsync(POLL_ROUND_DELAYS_MS[0]);

    const clickhouse = logs.span.children.find((c) => c.kind === 'clickhouse')!;
    expect(clickhouse.startMs).toBeGreaterThanOrEqual(0);
    expect(logs.span.children.some((c) => c.kind === 'transport')).toBe(false); // no room left for it
  });

  it('does not add a split for a span with no measured end (still running)', async () => {
    setEnrichmentEnabled(true);
    startAutoEnrichment(() => ({ datasourceUid: 'ds-1', config }));

    const action = startAction('a');
    const logs = action.child('logs', 'logs'); // never ended

    mockFetchServerStats.mockResolvedValueOnce({
      status: 'ok',
      rows: [
        {
          traceId: action.span.id,
          spanId: logs.span.id,
          queryId: 'q-1',
          type: 'QueryFinish',
          queryDurationMs: 840,
          readRows: 1,
          readBytes: 1,
          resultRows: 1,
          memoryUsage: 1,
        },
      ],
    });
    action.end('ok');
    await advancePastDebounce();
    await jest.advanceTimersByTimeAsync(POLL_ROUND_DELAYS_MS[0]);

    expect(logs.span.children).toEqual([]);
  });
});
