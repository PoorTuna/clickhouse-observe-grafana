/**
 * Covers runQuery.ts's log_comment tagging (diagnostics plan Phase 2) — gated on the enrichment
 * toggle, skipped for the diagnostics tier's own lookup query, and never traced/tagged at all for
 * runQueryUntracedRows.
 */
import { of } from 'rxjs';
import { DataFrame, DataQueryResponse, LoadingState, TimeRange, dateTime } from '@grafana/data';
import { runQueryRows, runQueryUntracedRows } from '../runQuery';
import { setEnrichmentEnabled } from '../../diag/enrichment';
import { __resetForTests, getRoots, startAction } from '../../diag/tracer';

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

function okResponse(): DataQueryResponse {
  const frame = { refId: 'A', fields: [], length: 0 } as unknown as DataFrame;
  return { data: [frame], state: LoadingState.Done };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockReturnValue(of(okResponse()));
  __resetForTests();
  setEnrichmentEnabled(false);
});

describe('log_comment tagging', () => {
  it('does not tag when enrichment is disabled (the default)', async () => {
    const action = startAction('Search submit');
    await runQueryRows({ datasourceUid: 'ds-1', sql: 'SELECT 1', timeRange, op: 'logs', trace: action });
    expect(mockQuery.mock.calls[0][0].targets[0].rawSql).not.toContain('log_comment');
  });

  it('tags with the trace/span/op when enrichment is enabled', async () => {
    setEnrichmentEnabled(true);
    const action = startAction('Search submit');
    await runQueryRows({ datasourceUid: 'ds-1', sql: 'SELECT 1', timeRange, op: 'logs', trace: action });
    const sentSql: string = mockQuery.mock.calls[0][0].targets[0].rawSql;
    expect(sentSql).toContain(`log_comment = 'chobs|${action.span.id}|`);
    expect(sentSql).toContain('|logs\'');
  });

  it('never tags the diagnostics tier lookup query itself, even with enrichment on', async () => {
    setEnrichmentEnabled(true);
    await runQueryUntracedRows({ datasourceUid: 'ds-1', sql: 'SELECT 1 FROM system.query_log', timeRange, op: 'serverStatsLookup' });
    expect(mockQuery.mock.calls[0][0].targets[0].rawSql).not.toContain('log_comment');
  });

  it('two spans under the same action share the same traceId prefix but differ in spanId', async () => {
    setEnrichmentEnabled(true);
    const action = startAction('Search submit');
    await runQueryRows({ datasourceUid: 'ds-1', sql: 'SELECT 1', timeRange, op: 'logs', trace: action });
    await runQueryRows({ datasourceUid: 'ds-1', sql: 'SELECT 2', timeRange, op: 'volume', trace: action });

    const firstSql: string = mockQuery.mock.calls[0][0].targets[0].rawSql;
    const secondSql: string = mockQuery.mock.calls[1][0].targets[0].rawSql;
    const tracePrefix = `chobs|${action.span.id}|`;
    expect(firstSql).toContain(tracePrefix);
    expect(secondSql).toContain(tracePrefix);
    expect(firstSql).not.toBe(secondSql);
  });
});

describe('runQueryUntracedRows', () => {
  it('does not create a tracer root — the rail stays free of infrastructure queries', async () => {
    await runQueryUntracedRows({ datasourceUid: 'ds-1', sql: 'SELECT 1', timeRange, op: 'serverStatsLookup' });
    expect(getRoots()).toHaveLength(0);
  });
});
