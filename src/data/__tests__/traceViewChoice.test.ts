/**
 * Tests for resolving an inbound trace->logs link's dsUid to a Data View — the ambiguous case
 * (several views share one datasource) is the whole reason this module exists; see its doc
 * comment. localStorage is cleared between tests since rememberView/getRememberedView persist to it.
 */
import { DataView } from '../../types';
import {
  forgetRememberedView,
  getRememberedView,
  rememberView,
  resolveTraceLanding,
} from '../traceViewChoice';

const DS_A = 'afrf0mt8ssn40d';
const DS_B = 'other-ds-uid';

function view(id: string, overrides: Partial<DataView> = {}): DataView {
  return {
    id,
    name: id,
    origin: 'shared',
    createdAt: '2024-01-01T00:00:00Z',
    datasourceUid: DS_A,
    database: 'default',
    logsTable: id,
    isOtel: false,
    columns: { timestamp: 'Timestamp', body: 'Body', severity: '', traceId: 'TraceId', serviceName: '', spanAttributes: '', partitionTimestamp: '' },
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('resolveTraceLanding', () => {
  it('returns none when dsUid is absent — the everyday non-trace-link startup', () => {
    const views = [view('otel_logs')];
    expect(resolveTraceLanding(views, undefined, null)).toEqual({ status: 'none' });
  });

  it('resolves directly when exactly one view matches the datasource', () => {
    const views = [view('otel_logs'), view('unrelated', { datasourceUid: DS_B })];
    expect(resolveTraceLanding(views, DS_A, null)).toEqual({ status: 'resolved', viewId: 'otel_logs' });
  });

  it('asks (ambiguous) when several views share the datasource, splitting by traceId mapping', () => {
    const views = [
      view('otel_logs'),
      view('app_logs', { columns: { timestamp: 'ts', body: 'msg', severity: '', traceId: '', serviceName: '', spanAttributes: '', partitionTimestamp: '' } }),
    ];
    const landing = resolveTraceLanding(views, DS_A, null);
    expect(landing.status).toBe('choosing');
    if (landing.status === 'choosing') {
      expect(landing.reason).toBe('ambiguous');
      expect(landing.matching.map((v) => v.id)).toEqual(['otel_logs']);
      expect(landing.others.map((v) => v.id)).toEqual(['app_logs']);
    }
  });

  it('asks (no-match) when no view uses that datasource, offering all views', () => {
    const views = [view('otel_logs', { datasourceUid: DS_B })];
    const landing = resolveTraceLanding(views, DS_A, null);
    expect(landing.status).toBe('choosing');
    if (landing.status === 'choosing') {
      expect(landing.reason).toBe('no-match');
      expect(landing.matching).toEqual([]);
      expect(landing.others.map((v) => v.id)).toEqual(['otel_logs']);
    }
  });

  it('honours a remembered choice that is still a valid candidate', () => {
    const views = [view('otel_logs'), view('app_logs')];
    expect(resolveTraceLanding(views, DS_A, 'app_logs')).toEqual({ status: 'resolved', viewId: 'app_logs' });
  });

  it('ignores a stale remembered id (view since deleted) and falls back to asking', () => {
    const views = [view('otel_logs'), view('app_logs')];
    const landing = resolveTraceLanding(views, DS_A, 'deleted_view');
    expect(landing.status).toBe('choosing');
  });

  it('ignores a remembered id that belongs to a different datasource than the current candidates', () => {
    const views = [view('otel_logs'), view('app_logs')];
    // 'unrelated' was remembered for DS_A previously but no longer exists among candidates.
    const landing = resolveTraceLanding(views, DS_A, 'unrelated');
    expect(landing.status).toBe('choosing');
  });
});

describe('remembered-choice persistence', () => {
  it('round-trips remember/get/forget', () => {
    expect(getRememberedView(DS_A)).toBeNull();
    rememberView(DS_A, 'otel_logs');
    expect(getRememberedView(DS_A)).toBe('otel_logs');
    forgetRememberedView(DS_A);
    expect(getRememberedView(DS_A)).toBeNull();
  });

  it('keeps separate datasources independent', () => {
    rememberView(DS_A, 'otel_logs');
    rememberView(DS_B, 'other_view');
    expect(getRememberedView(DS_A)).toBe('otel_logs');
    expect(getRememberedView(DS_B)).toBe('other_view');
  });
});
