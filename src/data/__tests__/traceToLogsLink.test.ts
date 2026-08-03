/**
 * Tests for the trace->logs link builder (reverse direction of traceLinks.ts). Verifies the
 * datasource-type gate, hex traceID validation, and the microsecond->millisecond conversion +
 * padding for the derived time range — decodes the produced path's query params rather than
 * string-matching the URL, matching traceLinks.test.ts's convention.
 */
import { buildTraceToLogsPath, TraceViewLinkContext } from '../traceToLogsLink';
import { PLUGIN_BASE_URL } from '../../constants';

const CH_DATASOURCE = { uid: 'afrf0mt8ssn40d', type: 'grafana-clickhouse-datasource', name: 'ClickHouse' };

function decode(path: string | undefined) {
  if (!path) {
    return undefined;
  }
  const [base, query] = path.split('?');
  return { base, params: new URLSearchParams(query) };
}

describe('buildTraceToLogsPath', () => {
  it('builds a path with traceId/dsUid for a ClickHouse trace', () => {
    const ctx: TraceViewLinkContext = {
      traceID: 'deadbeefcafebabe0123456789abcdef',
      startTime: 1_700_000_000_000_000, // µs
      endTime: 1_700_000_000_100_000, // µs
      datasource: CH_DATASOURCE,
    };
    const decoded = decode(buildTraceToLogsPath(ctx));
    expect(decoded?.base).toBe(`${PLUGIN_BASE_URL}/logs`);
    expect(decoded?.params.get('traceId')).toBe('deadbeefcafebabe0123456789abcdef');
    expect(decoded?.params.get('dsUid')).toBe('afrf0mt8ssn40d');
  });

  it('converts microseconds to padded milliseconds, preferring endTime', () => {
    const startUs = 1_700_000_000_000_000;
    const endUs = 1_700_000_000_500_000; // 500ms after start
    const ctx: TraceViewLinkContext = {
      traceID: 'deadbeefcafebabe0123456789abcdef',
      startTime: startUs,
      endTime: endUs,
      duration: 999_000_000, // large — must be ignored since endTime is present
      datasource: CH_DATASOURCE,
    };
    const decoded = decode(buildTraceToLogsPath(ctx));
    const from = Number(decoded?.params.get('from'));
    const to = Number(decoded?.params.get('to'));
    const PAD_MS = 5 * 60 * 1000;
    expect(from).toBe(startUs / 1000 - PAD_MS);
    expect(to).toBe(endUs / 1000 + PAD_MS);
  });

  it('falls back to startTime + duration when endTime is absent', () => {
    const startUs = 1_700_000_000_000_000;
    const durationUs = 250_000; // 250ms
    const ctx: TraceViewLinkContext = {
      traceID: 'deadbeefcafebabe0123456789abcdef',
      startTime: startUs,
      duration: durationUs,
      datasource: CH_DATASOURCE,
    };
    const decoded = decode(buildTraceToLogsPath(ctx));
    const PAD_MS = 5 * 60 * 1000;
    expect(Number(decoded?.params.get('from'))).toBe(startUs / 1000 - PAD_MS);
    expect(Number(decoded?.params.get('to'))).toBe(startUs / 1000 + durationUs / 1000 + PAD_MS);
  });

  it('omits from/to when neither endTime nor duration is finite', () => {
    const ctx: TraceViewLinkContext = {
      traceID: 'deadbeefcafebabe0123456789abcdef',
      startTime: NaN,
      datasource: CH_DATASOURCE,
    };
    const decoded = decode(buildTraceToLogsPath(ctx));
    expect(decoded?.params.has('from')).toBe(false);
    expect(decoded?.params.has('to')).toBe(false);
  });

  it('hides the link (returns undefined) for a non-ClickHouse datasource', () => {
    const ctx: TraceViewLinkContext = {
      traceID: 'deadbeefcafebabe0123456789abcdef',
      startTime: 1_700_000_000_000_000,
      datasource: { uid: 'tempo-uid', type: 'tempo', name: 'Tempo' },
    };
    expect(buildTraceToLogsPath(ctx)).toBeUndefined();
  });

  it('hides the link when context is missing', () => {
    expect(buildTraceToLogsPath(undefined)).toBeUndefined();
  });

  it('hides the link for a non-hex traceID', () => {
    const ctx: TraceViewLinkContext = {
      traceID: 'not-a-hex-id!',
      startTime: 1_700_000_000_000_000,
      datasource: CH_DATASOURCE,
    };
    expect(buildTraceToLogsPath(ctx)).toBeUndefined();
  });

  it('hides the link when traceID is empty', () => {
    const ctx: TraceViewLinkContext = {
      traceID: '',
      startTime: 1_700_000_000_000_000,
      datasource: CH_DATASOURCE,
    };
    expect(buildTraceToLogsPath(ctx)).toBeUndefined();
  });
});
