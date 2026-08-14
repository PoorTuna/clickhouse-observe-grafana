/**
 * Covers fetchServerStats' polling/backoff and error classification. runQueryUntracedRows itself
 * is mocked — the SQL it sends is covered by runQuery.enrichment.test.ts and the query shape is
 * exercised indirectly here via the mock's call arguments.
 */
import { EMPTY_COLUMN_MAPPING, SourceConfig } from '../../types';
import { fetchServerStats } from '../serverStats';

const runQueryUntracedRows = jest.fn();

jest.mock('../../data/runQuery', () => ({
  runQueryUntracedRows: (...args: unknown[]) => runQueryUntracedRows(...args),
}));

const config: SourceConfig = {
  datasourceUid: 'ds-1',
  database: 'default',
  logsTable: 't',
  isOtel: false,
  columns: { ...EMPTY_COLUMN_MAPPING },
};

beforeEach(() => {
  runQueryUntracedRows.mockReset();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

async function runAndFlush<T>(promise: Promise<T>): Promise<T> {
  // Each poll attempt: advance past its delay, let the mocked query's microtask resolve.
  for (let i = 0; i < 3; i++) {
    await jest.advanceTimersByTimeAsync(8000);
  }
  return promise;
}

describe('fetchServerStats', () => {
  it('returns ok with parsed rows once a poll attempt finds data', async () => {
    runQueryUntracedRows.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        span_id: 'span-2',
        query_id: 'q-1',
        type: 'QueryFinish',
        query_duration_ms: 840,
        read_rows: 12400000,
        read_bytes: 310000000,
        result_rows: 100,
        memory_usage: 5000000,
        selected_marks: 96,
        selected_parts: 3,
        selected_ranges: 10,
        os_read_bytes: 200000000,
        exception_code: 0,
        exception: '',
      },
    ]);

    const result = await runAndFlush(fetchServerStats('ds-1', config, 'trace-1'));
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ spanId: 'span-2', queryDurationMs: 840, readRows: 12400000, selectedMarks: 96 });
    }
  });

  it('drops rows with no span_id rather than crashing on them', async () => {
    runQueryUntracedRows.mockResolvedValue([{ query_id: 'q-1', type: 'QueryFinish' }]);
    const result = await runAndFlush(fetchServerStats('ds-1', config, 'trace-1'));
    expect(result).toEqual({ status: 'no-data' });
  });

  it('returns no-data after exhausting every poll attempt with nothing', async () => {
    runQueryUntracedRows.mockResolvedValue([]);
    const result = await runAndFlush(fetchServerStats('ds-1', config, 'trace-1'));
    expect(result).toEqual({ status: 'no-data' });
    expect(runQueryUntracedRows).toHaveBeenCalledTimes(3);
  });

  it('classifies a permissions error as no-grant, without retrying', async () => {
    runQueryUntracedRows.mockRejectedValueOnce(new Error('Code: 497. DB::Exception: default: Not enough privileges'));
    const result = await runAndFlush(fetchServerStats('ds-1', config, 'trace-1'));
    expect(result).toEqual({
      status: 'unavailable',
      reason: 'no-grant',
      detail: 'Code: 497. DB::Exception: default: Not enough privileges',
    });
    expect(runQueryUntracedRows).toHaveBeenCalledTimes(1);
  });

  it('classifies a readonly-mode rejection as readonly', async () => {
    runQueryUntracedRows.mockRejectedValueOnce(new Error("Cannot modify 'max_execution_time' setting in readonly mode"));
    const result = await runAndFlush(fetchServerStats('ds-1', config, 'trace-1'));
    expect(result).toMatchObject({ status: 'unavailable', reason: 'readonly' });
  });

  it('falls back to a generic error reason for anything else', async () => {
    runQueryUntracedRows.mockRejectedValueOnce(new Error('Connection reset'));
    const result = await runAndFlush(fetchServerStats('ds-1', config, 'trace-1'));
    expect(result).toMatchObject({ status: 'unavailable', reason: 'error' });
  });

  it('scopes the lookup to the given trace via a startsWith prefix on the tag', async () => {
    runQueryUntracedRows.mockResolvedValue([]);
    await runAndFlush(fetchServerStats('ds-1', config, 'trace-42'));
    const sentSql: string = runQueryUntracedRows.mock.calls[0][0].sql;
    expect(sentSql).toContain("startsWith(log_comment, 'chobs|trace-42|')");
    expect(runQueryUntracedRows.mock.calls[0][0].op).toBe('serverStatsLookup');
  });

  it('uses clusterAllReplicas when config.clusterName is set', async () => {
    runQueryUntracedRows.mockResolvedValue([]);
    await runAndFlush(fetchServerStats('ds-1', { ...config, clusterName: 'my_cluster' }, 'trace-1'));
    const sentSql: string = runQueryUntracedRows.mock.calls[0][0].sql;
    expect(sentSql).toContain('clusterAllReplicas("my_cluster", system.query_log)');
  });

  it('uses the plain table when no clusterName is configured', async () => {
    runQueryUntracedRows.mockResolvedValue([]);
    await runAndFlush(fetchServerStats('ds-1', config, 'trace-1'));
    const sentSql: string = runQueryUntracedRows.mock.calls[0][0].sql;
    expect(sentSql).toContain('FROM system.query_log');
    expect(sentSql).not.toContain('clusterAllReplicas');
  });
});
