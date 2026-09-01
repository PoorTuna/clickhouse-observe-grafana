/**
 * sql/keys.ts's cache hardening: a Map key list is sample-scoped (a LIMIT-bounded read of current
 * row data, not metadata), and coarseTimeBucket returns a *stable* key for a relative time range
 * (`now-1h|now` never rolls over on its own — see sql/timeBucket.ts) — so without a TTL, a key
 * added after the sample was taken would stay invisible for the rest of the session. Also covers
 * the in-flight de-dup that lets the sidebar and the search bar share one query for the same
 * column, and clearKeysCacheForTable (FieldsContext's explicit refresh()).
 */
import { TimeRange, dateTime } from '@grafana/data';
import { runQueryRows } from '../../data/runQuery';
import { loadColumnKeys, peekColumnKeys, KEYS_TTL_MS, __resetKeysCacheForTests } from '../keys';
import { SourceConfig, OTEL_COLUMN_MAPPING } from '../../types';

jest.mock('../../data/runQuery');
const mockRunQueryRows = runQueryRows as jest.MockedFunction<typeof runQueryRows>;

const config: SourceConfig = {
  datasourceUid: 'ds-uid-1',
  database: 'default',
  logsTable: 'otel_logs',
  isOtel: true,
  columns: OTEL_COLUMN_MAPPING,
};

const timeRange: TimeRange = {
  from: dateTime('2026-01-01T00:00:00Z'),
  to: dateTime('2026-01-01T01:00:00Z'),
  raw: { from: 'now-1h', to: 'now' }, // relative — coarseTimeBucket never rolls over on its own
};

function opts() {
  return { table: config.logsTable, conditions: [] as string[], timeRange, cacheKey: '[]' };
}

describe('sql/keys.ts caching', () => {
  beforeEach(() => {
    mockRunQueryRows.mockReset();
    __resetKeysCacheForTests();
  });

  it('caches a fetch: two calls with the same key only query once', async () => {
    mockRunQueryRows.mockResolvedValue([{ k: 'a', total: 3 }]);
    await loadColumnKeys(config, 'LogAttributes', opts());
    await loadColumnKeys(config, 'LogAttributes', opts());
    expect(mockRunQueryRows).toHaveBeenCalledTimes(1);
  });

  it('de-dupes concurrent callers for the same column into one query', async () => {
    let resolveQuery: (rows: Array<Record<string, unknown>>) => void = () => {};
    mockRunQueryRows.mockImplementation(
      () => new Promise((resolve) => { resolveQuery = resolve; })
    );
    const p1 = loadColumnKeys(config, 'LogAttributes', opts());
    const p2 = loadColumnKeys(config, 'LogAttributes', opts());
    expect(mockRunQueryRows).toHaveBeenCalledTimes(1);
    resolveQuery([{ k: 'a', total: 1 }]);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
    expect(r1.keys).toEqual([{ key: 'a' }]);
  });

  it('a cached entry older than the TTL is treated as a miss and re-queried', async () => {
    const realNow = Date.now;
    try {
      let now = 1_000_000;
      Date.now = () => now;

      mockRunQueryRows.mockResolvedValueOnce([{ k: 'a', total: 1 }]);
      await loadColumnKeys(config, 'LogAttributes', opts());
      expect(mockRunQueryRows).toHaveBeenCalledTimes(1);

      // Still within the TTL — cache hit, no second query.
      now += KEYS_TTL_MS - 1;
      await loadColumnKeys(config, 'LogAttributes', opts());
      expect(mockRunQueryRows).toHaveBeenCalledTimes(1);

      // Past the TTL — must re-query even though coarseTimeBucket's key string hasn't changed.
      now += 2;
      mockRunQueryRows.mockResolvedValueOnce([{ k: 'a', total: 5 }]);
      const result = await loadColumnKeys(config, 'LogAttributes', opts());
      expect(mockRunQueryRows).toHaveBeenCalledTimes(2);
      expect(result.total).toBe(5);
    } finally {
      Date.now = realNow;
    }
  });

  it('peekColumnKeys returns undefined on a miss and the cached value on a fresh hit', async () => {
    expect(peekColumnKeys(config.datasourceUid, 'LogAttributes', timeRange, opts())).toBeUndefined();
    mockRunQueryRows.mockResolvedValue([{ k: 'a', total: 1 }]);
    await loadColumnKeys(config, 'LogAttributes', opts());
    expect(peekColumnKeys(config.datasourceUid, 'LogAttributes', timeRange, opts())?.keys).toEqual([{ key: 'a' }]);
  });

  it('different columns on the same table cache independently', async () => {
    mockRunQueryRows
      .mockResolvedValueOnce([{ k: 'a', total: 1 }])
      .mockResolvedValueOnce([{ k: 'b', total: 2 }]);
    const logAttrs = await loadColumnKeys(config, 'LogAttributes', opts());
    const resourceAttrs = await loadColumnKeys(config, 'ResourceAttributes', opts());
    expect(logAttrs.keys).toEqual([{ key: 'a' }]);
    expect(resourceAttrs.keys).toEqual([{ key: 'b' }]);
    expect(mockRunQueryRows).toHaveBeenCalledTimes(2);
  });

  describe('clearKeysCacheForTable', () => {
    it('drops every cached entry for the given uid+table but leaves other tables intact', async () => {
      const { clearKeysCacheForTable } = await import('../keys');
      mockRunQueryRows.mockResolvedValue([{ k: 'a', total: 1 }]);
      await loadColumnKeys(config, 'LogAttributes', opts());
      await loadColumnKeys({ ...config, logsTable: 'other_table' }, 'LogAttributes', {
        ...opts(),
        table: 'other_table',
      });
      expect(mockRunQueryRows).toHaveBeenCalledTimes(2);

      clearKeysCacheForTable(config.datasourceUid, config.logsTable);

      // otel_logs entry gone — re-queries.
      await loadColumnKeys(config, 'LogAttributes', opts());
      expect(mockRunQueryRows).toHaveBeenCalledTimes(3);

      // other_table entry untouched — cache hit, no new query.
      await loadColumnKeys({ ...config, logsTable: 'other_table' }, 'LogAttributes', {
        ...opts(),
        table: 'other_table',
      });
      expect(mockRunQueryRows).toHaveBeenCalledTimes(3);
    });
  });
});
