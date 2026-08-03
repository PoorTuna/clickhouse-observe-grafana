/**
 * Round-trip tests for the Logs Explorer shareable-URL encode/decode helpers.
 */

import { dateTime } from '@grafana/data';
import { encodeLogsState, decodeLogsState } from '../urlState';
import { FilterPill, SelectedColumn } from '../../types';

const filters: FilterPill[] = [
  { id: 'f1', field: 'SeverityText', op: '=', value: 'ERROR' },
];

const columns: SelectedColumn[] = [
  { id: 'timestamp', key: '__timestamp', sqlExpr: 'Timestamp', displayName: 'Time', type: 'time', isCore: true },
  { id: 'body', key: '__body', sqlExpr: 'Body', displayName: 'Message', type: 'text', isCore: true },
];

const disabledFilters: FilterPill[] = [
  { id: 'f1', field: 'SeverityText', op: '=', value: 'ERROR' },
  { id: 'f2', field: 'HostName', op: '!=', value: 'host-1', disabled: true },
];

describe('encodeLogsState / decodeLogsState round-trip', () => {
  it('round-trips a disabled filter pill', () => {
    const timeRange = {
      from: dateTime(Date.now() - 3600_000),
      to: dateTime(Date.now()),
      raw: { from: 'now-1h', to: 'now' },
    };
    const encoded = encodeLogsState({
      search: '',
      filters: disabledFilters,
      columns: [],
      timeRange,
    });
    const decoded = decodeLogsState(encoded);
    expect(decoded.filters).toEqual(disabledFilters);
    expect(decoded.filters?.[1].disabled).toBe(true);
  });


  it('round-trips search, filters, columns, sort, relative time range, and view id', () => {
    const timeRange = {
      from: dateTime(Date.now() - 3600_000),
      to: dateTime(Date.now()),
      raw: { from: 'now-1h', to: 'now' },
    };
    const encoded = encodeLogsState({
      search: 'error',
      filters,
      columns,
      sort: { col: '__timestamp', dir: 'desc' },
      timeRange,
      viewId: 'shared_123',
    });
    const decoded = decodeLogsState(encoded);

    expect(decoded.search).toBe('error');
    expect(decoded.filters).toEqual(filters);
    expect(decoded.columns).toEqual(columns);
    expect(decoded.sort).toEqual({ col: '__timestamp', dir: 'desc' });
    expect(decoded.viewId).toBe('shared_123');
    // Relative range preserved as 'now-1h'/'now', not frozen to an absolute instant.
    expect(decoded.timeRange?.raw.from).toBe('now-1h');
    expect(decoded.timeRange?.raw.to).toBe('now');
  });

  it('round-trips an absolute time range as epoch-ms, not a relative string', () => {
    const from = dateTime(1700000000000);
    const to = dateTime(1700003600000);
    const encoded = encodeLogsState({
      search: '',
      filters: [],
      columns: [],
      timeRange: { from, to, raw: { from, to } },
    });
    const decoded = decodeLogsState(encoded);
    expect(decoded.timeRange?.from.valueOf()).toBe(1700000000000);
    expect(decoded.timeRange?.to.valueOf()).toBe(1700003600000);
  });

  it('omits empty search/filters/columns/sort/viewId from the URL entirely', () => {
    const encoded = encodeLogsState({
      search: '   ',
      filters: [],
      columns: [],
      timeRange: { from: dateTime(0), to: dateTime(1), raw: { from: 'now-1h', to: 'now' } },
    });
    expect(encoded.has('q')).toBe(false);
    expect(encoded.has('filters')).toBe(false);
    expect(encoded.has('cols')).toBe(false);
    expect(encoded.has('sort')).toBe(false);
    expect(encoded.has('ds')).toBe(false);
  });

  it('decode is best-effort: malformed filters/cols JSON is dropped, not thrown', () => {
    const sp = new URLSearchParams();
    sp.set('filters', '{not valid json');
    sp.set('cols', '"a string, not an array"');
    sp.set('sort', 'garbage-no-colon');
    const decoded = decodeLogsState(sp);
    expect(decoded.filters).toBeUndefined();
    expect(decoded.columns).toBeUndefined();
    expect(decoded.sort).toBeUndefined();
  });

  it('decode returns an empty object for an empty URLSearchParams', () => {
    const decoded = decodeLogsState(new URLSearchParams());
    expect(decoded).toEqual({});
  });

  it('decodes traceId/dsUid — the inbound-only trace->logs deep-link contract', () => {
    const sp = new URLSearchParams();
    sp.set('traceId', 'deadbeefcafebabe0123456789abcdef');
    sp.set('dsUid', 'afrf0mt8ssn40d');
    const decoded = decodeLogsState(sp);
    expect(decoded.traceId).toBe('deadbeefcafebabe0123456789abcdef');
    expect(decoded.dsUid).toBe('afrf0mt8ssn40d');
  });

  it('never emits traceId/dsUid from encodeLogsState — they are decode-only', () => {
    const encoded = encodeLogsState({
      search: 'error',
      filters,
      columns,
      timeRange: { from: dateTime(0), to: dateTime(1), raw: { from: 'now-1h', to: 'now' } },
      viewId: 'shared_123',
    });
    expect(encoded.has('traceId')).toBe(false);
    expect(encoded.has('dsUid')).toBe(false);
  });
});
