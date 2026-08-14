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

// Flushes the microtask queue so the fire-and-forget `void enrichRoot(...)` inside the onRootEnd
// listener has a chance to run before assertions.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  resetTracer();
  resetAutoEnrich();
  mockFetchServerStats.mockReset();
  setEnrichmentEnabled(false);
});

describe('startAutoEnrichment', () => {
  it('does nothing when enrichment is disabled, but stamps the root not-tagged', async () => {
    startAutoEnrichment(() => ({ datasourceUid: 'ds-1', config }));
    const action = startAction('a');
    action.end('ok');
    await flush();
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
    await flush();
    expect(mockFetchServerStats).not.toHaveBeenCalled();
    expect(action.span.attrs.serverStatsStatus).toBe('not-tagged');
  });

  it('stamps pending synchronously when a lookup starts, before it resolves', async () => {
    setEnrichmentEnabled(true);
    startAutoEnrichment(() => ({ datasourceUid: 'ds-1', config }));
    let resolveLookup: (value: unknown) => void = () => {};
    mockFetchServerStats.mockReturnValueOnce(new Promise((resolve) => (resolveLookup = resolve)));

    const action = startAction('a');
    action.end('ok');
    await flush();
    expect(action.span.attrs.serverStatsStatus).toBe('pending');

    resolveLookup({ status: 'no-data' });
    await flush();
    expect(action.span.attrs.serverStatsStatus).toBe('no-data');
  });

  it('fetches stats for the root and applies matching rows to query spans by spanId', async () => {
    setEnrichmentEnabled(true);
    startAutoEnrichment(() => ({ datasourceUid: 'ds-1', config }));

    const action = startAction('Search submit');
    const logs = action.child('logs', 'logs');
    mockFetchServerStats.mockResolvedValueOnce({
      status: 'ok',
      rows: [{ spanId: logs.span.id, queryId: 'q-1', type: 'QueryFinish', queryDurationMs: 840, readRows: 12400000, readBytes: 1, resultRows: 100, memoryUsage: 1 }],
    });
    logs.end('ok');
    action.end('ok');
    await flush();

    expect(mockFetchServerStats).toHaveBeenCalledWith('ds-1', config, action.span.id);
    expect(logs.span.attrs.serverDurationMs).toBe(840);
    expect(logs.span.attrs.serverReadRows).toBe(12400000);
    expect(action.span.attrs.serverStatsStatus).toBe('ok');
  });

  it('does not attach server attrs to a span with no matching row', async () => {
    setEnrichmentEnabled(true);
    startAutoEnrichment(() => ({ datasourceUid: 'ds-1', config }));

    const action = startAction('a');
    const logs = action.child('logs', 'logs');
    mockFetchServerStats.mockResolvedValueOnce({ status: 'ok', rows: [] });
    logs.end('ok');
    action.end('ok');
    await flush();

    expect(logs.span.attrs.serverDurationMs).toBeUndefined();
  });

  it('records a no-data result on the root without touching child spans', async () => {
    setEnrichmentEnabled(true);
    startAutoEnrichment(() => ({ datasourceUid: 'ds-1', config }));

    const action = startAction('a');
    mockFetchServerStats.mockResolvedValueOnce({ status: 'no-data' });
    action.end('ok');
    await flush();

    expect(action.span.attrs.serverStatsStatus).toBe('no-data');
  });

  it('records an unavailable result with its reason and detail on the root', async () => {
    setEnrichmentEnabled(true);
    startAutoEnrichment(() => ({ datasourceUid: 'ds-1', config }));

    const action = startAction('a');
    mockFetchServerStats.mockResolvedValueOnce({ status: 'unavailable', reason: 'no-grant', detail: 'Not enough privileges' });
    action.end('ok');
    await flush();

    expect(action.span.attrs).toMatchObject({
      serverStatsStatus: 'unavailable',
      serverStatsReason: 'no-grant',
      serverStatsDetail: 'Not enough privileges',
    });
  });
});
