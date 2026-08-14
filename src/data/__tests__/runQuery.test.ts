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
import { Observable, of } from 'rxjs';
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

const baseOptions = { datasourceUid: 'ds-uid-1', sql: 'SELECT 1', timeRange, op: 'logs' as const };

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

// See runQuery.ts's RunQueryOptions.signal doc comment: this does NOT cancel the query on
// ClickHouse (verified against Grafana core — the standard fetch() path isn't wired to an
// AbortController on unsubscribe). It only makes runQuery() stop waiting on / decoding a response
// nobody will use, and lets the caller mark its span cancelled promptly instead of hanging.
describe('runQuery — abort signal (client-side only, does not reach ClickHouse)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('rejects immediately with an AbortError if the signal is already aborted', async () => {
    mockQuery.mockReturnValue(of<DataQueryResponse>({ data: [], state: LoadingState.Done }));
    const controller = new AbortController();
    controller.abort();

    await expect(runQuery({ ...baseOptions, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    // Never even calls into the datasource once already aborted.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('unsubscribes and rejects with an AbortError when aborted mid-flight', async () => {
    let unsubscribed = false;
    const never = new Observable<DataQueryResponse>(() => {
      // Never emits/completes on its own — simulates a slow in-flight request.
      return () => {
        unsubscribed = true;
      };
    });
    mockQuery.mockReturnValue(never);

    const controller = new AbortController();
    const promise = runQuery({ ...baseOptions, signal: controller.signal });
    // runQuery awaits getDataSourceSrv().get(...) before subscribing, so give that microtask a
    // turn to resolve before aborting — otherwise the abort listener isn't registered yet.
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(unsubscribed).toBe(true);
  });

  it('resolves normally when never aborted', async () => {
    const frame = { refId: 'A', fields: [], length: 0 } as unknown as DataFrame;
    mockQuery.mockReturnValue(of<DataQueryResponse>({ data: [frame], state: LoadingState.Done }));
    const controller = new AbortController();

    await expect(runQuery({ ...baseOptions, signal: controller.signal })).resolves.toEqual([frame]);
  });
});
