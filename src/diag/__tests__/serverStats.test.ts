/**
 * Covers fetchServerStats — a single, non-retrying system.query_log lookup attempt for a batch of
 * trace ids (see the B3 finding: polling/backoff across multiple attempts now lives one level up,
 * in diag/autoEnrich.ts, which coalesces many roots into one shared poll cycle instead of each root
 * running its own). runQueryUntracedRows itself is mocked — the SQL it sends is covered by
 * runQuery.enrichment.test.ts and the query shape is exercised indirectly here via the mock's call
 * arguments.
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
});

describe('fetchServerStats', () => {
  it('returns ok with parsed rows when the lookup finds data', async () => {
    runQueryUntracedRows.mockResolvedValueOnce([
      {
        trace_id: 'trace-1',
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

    const result = await fetchServerStats('ds-1', config, ['trace-1']);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        traceId: 'trace-1',
        spanId: 'span-2',
        queryDurationMs: 840,
        readRows: 12400000,
        selectedMarks: 96,
      });
    }
    expect(runQueryUntracedRows).toHaveBeenCalledTimes(1);
  });

  it('drops rows with no trace_id or span_id rather than crashing on them', async () => {
    runQueryUntracedRows.mockResolvedValue([{ query_id: 'q-1', type: 'QueryFinish' }]);
    const result = await fetchServerStats('ds-1', config, ['trace-1']);
    expect(result).toEqual({ status: 'no-data' });
  });

  it('returns no-data (not an error) when the query succeeds with zero matching rows', async () => {
    runQueryUntracedRows.mockResolvedValue([]);
    const result = await fetchServerStats('ds-1', config, ['trace-1']);
    expect(result).toEqual({ status: 'no-data' });
    expect(runQueryUntracedRows).toHaveBeenCalledTimes(1);
  });

  it('returns no-data without issuing a query when traceIds is empty', async () => {
    const result = await fetchServerStats('ds-1', config, []);
    expect(result).toEqual({ status: 'no-data' });
    expect(runQueryUntracedRows).not.toHaveBeenCalled();
  });

  it('classifies a permissions error as no-grant, without retrying', async () => {
    runQueryUntracedRows.mockRejectedValueOnce(new Error('Code: 497. DB::Exception: default: Not enough privileges'));
    const result = await fetchServerStats('ds-1', config, ['trace-1']);
    expect(result).toEqual({
      status: 'unavailable',
      reason: 'no-grant',
      detail: 'Code: 497. DB::Exception: default: Not enough privileges',
    });
    expect(runQueryUntracedRows).toHaveBeenCalledTimes(1);
  });

  it('classifies a readonly-mode rejection as readonly', async () => {
    runQueryUntracedRows.mockRejectedValueOnce(new Error("Cannot modify 'max_execution_time' setting in readonly mode"));
    const result = await fetchServerStats('ds-1', config, ['trace-1']);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'readonly' });
  });

  it('falls back to a generic error reason for anything else', async () => {
    runQueryUntracedRows.mockRejectedValueOnce(new Error('Connection reset'));
    const result = await fetchServerStats('ds-1', config, ['trace-1']);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'error' });
  });

  it('scopes the lookup to every given trace via an IN() on the parsed trace id', async () => {
    runQueryUntracedRows.mockResolvedValue([]);
    await fetchServerStats('ds-1', config, ['trace-42', 'trace-7']);
    const sentSql: string = runQueryUntracedRows.mock.calls[0][0].sql;
    expect(sentSql).toContain("startsWith(log_comment, 'chobs|')");
    expect(sentSql).toContain("splitByChar('|', log_comment)[2] IN ('trace-42', 'trace-7')");
    expect(runQueryUntracedRows.mock.calls[0][0].op).toBe('serverStatsLookup');
  });

  it('orders by event_time so which rows survive LIMIT is deterministic across a broad multi-trace scan', async () => {
    runQueryUntracedRows.mockResolvedValue([]);
    await fetchServerStats('ds-1', config, ['trace-1']);
    const sentSql: string = runQueryUntracedRows.mock.calls[0][0].sql;
    expect(sentSql).toContain('ORDER BY event_time DESC');
  });

  it('uses clusterAllReplicas when config.clusterName is set', async () => {
    runQueryUntracedRows.mockResolvedValue([]);
    await fetchServerStats('ds-1', { ...config, clusterName: 'my_cluster' }, ['trace-1']);
    const sentSql: string = runQueryUntracedRows.mock.calls[0][0].sql;
    expect(sentSql).toContain('clusterAllReplicas("my_cluster", system.query_log)');
  });

  it('uses the plain table when no clusterName is configured', async () => {
    runQueryUntracedRows.mockResolvedValue([]);
    await fetchServerStats('ds-1', config, ['trace-1']);
    const sentSql: string = runQueryUntracedRows.mock.calls[0][0].sql;
    expect(sentSql).toContain('FROM system.query_log');
    expect(sentSql).not.toContain('clusterAllReplicas');
  });
});
