/**
 * Regression coverage for C0: the ClickHouse datasource resolves (never rejects) its query()
 * Observable even when a query failed server-side — Grafana's DataQueryResponse carries
 * `.error`/`.errors` *alongside* `.data` rather than throwing (see @grafana/runtime's
 * toDataQueryResponse, and CHDatasource.query()'s own catchError, which both only ever emit a
 * resolved value). Before this fix, runQuery() returned `response.data` unconditionally, so every
 * ClickHouse error (bad SQL, a `timeout_overflow_mode = 'throw'` guardrail firing, permissions)
 * silently surfaced as an empty/partial result instead of a catchable error — no `catch` block
 * anywhere in this codebase ever fired for a ClickHouse query error.
 */
import { of } from 'rxjs';
import { DataFrame, DataQueryResponse, LoadingState, TimeRange, dateTime } from '@grafana/data';
import { runQuery, runQueryRows } from '../runQuery';

const mockQuery = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getDataSourceSrv: () => ({
    get: async () => ({ query: mockQuery }),
  }),
}));

const timeRange: TimeRange = {
  from: dateTime('2026-01-01T00:00:00Z'),
  to: dateTime('2026-01-01T01:00:00Z'),
  raw: { from: 'now-1h', to: 'now' },
};

const baseOptions = { datasourceUid: 'ds-uid-1', sql: 'SELECT 1', timeRange };

describe('runQuery — surfacing DataQueryResponse.error/.errors', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('resolves with data on a normal successful response', async () => {
    const frame = { refId: 'A', fields: [], length: 0 } as unknown as DataFrame;
    mockQuery.mockReturnValue(of<DataQueryResponse>({ data: [frame], state: LoadingState.Done }));

    const frames = await runQuery(baseOptions);
    expect(frames).toEqual([frame]);
  });

  it('throws using .errors[0].message when the response resolves with errors populated', async () => {
    mockQuery.mockReturnValue(
      of<DataQueryResponse>({
        data: [],
        state: LoadingState.Error,
        errors: [{ message: 'Code: 159. DB::Exception: Timeout exceeded: elapsed 60.001 seconds' }],
      })
    );

    await expect(runQuery(baseOptions)).rejects.toThrow('Timeout exceeded: elapsed 60.001 seconds');
  });

  it('throws using .error.message when only the deprecated single-error field is populated', async () => {
    mockQuery.mockReturnValue(
      of<DataQueryResponse>({
        data: [],
        state: LoadingState.Error,
        error: { message: 'Code: 60. DB::Exception: Unknown table' },
      })
    );

    await expect(runQuery(baseOptions)).rejects.toThrow('Unknown table');
  });

  it('combines every field a DataQueryError carries rather than picking just one', async () => {
    mockQuery.mockReturnValue(
      of<DataQueryResponse>({
        data: [],
        state: LoadingState.Error,
        errors: [{ status: 504, statusText: 'Gateway Timeout' }],
      })
    );

    await expect(runQuery(baseOptions)).rejects.toThrow('HTTP 504 Gateway Timeout');
  });

  it('never falls back to an ambiguous generic message when an error object is present but empty', async () => {
    mockQuery.mockReturnValue(
      of<DataQueryResponse>({ data: [], state: LoadingState.Error, errors: [{}] })
    );

    await expect(runQuery(baseOptions)).rejects.toThrow(/ClickHouse query failed:.*\{/);
  });

  it('runQueryRows also rejects instead of silently returning an empty row list', async () => {
    mockQuery.mockReturnValue(
      of<DataQueryResponse>({
        data: [],
        state: LoadingState.Error,
        errors: [{ message: 'Timeout exceeded' }],
      })
    );

    await expect(runQueryRows(baseOptions)).rejects.toThrow('Timeout exceeded');
  });
});
