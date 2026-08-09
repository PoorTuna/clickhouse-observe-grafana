/**
 * Regression coverage: field discovery must surface a scan failure, not silently swallow it into
 * an empty key list. Before this change, buildMapKeysQuery/buildJsonPathsQuery capped at 1000 rows
 * with `read_overflow_mode = 'break'` and FieldsContext caught per-column errors into `keys: []` —
 * a Map/JSON column that failed to scan looked identical to one with genuinely zero keys, and the
 * log detail drawer silently rendered without that column's flattened attribute rows. Discovery now
 * throws instead of truncating (see introspection.ts's DISCOVERY_SETTINGS), so a real failure must
 * reach useFieldDiscovery's `error`, alongside whatever fields *did* discover successfully.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { useFieldDiscovery } from '../FieldsContext';
import { runQueryRows } from '../../data/runQuery';
import { DEFAULT_SOURCE_CONFIG, SourceConfig } from '../../types';
import { TimeRange, dateTime } from '@grafana/data';

jest.mock('../../data/runQuery');

const mockRunQueryRows = runQueryRows as jest.MockedFunction<typeof runQueryRows>;

const config: SourceConfig = {
  ...DEFAULT_SOURCE_CONFIG,
  datasourceUid: 'ds-uid-1',
  database: 'default',
  logsTable: 'otel_logs',
};

const timeRange: TimeRange = {
  from: dateTime('2026-01-01T00:00:00Z'),
  to: dateTime('2026-01-01T01:00:00Z'),
  raw: { from: 'now-1h', to: 'now' },
};

describe('useFieldDiscovery — discovery failure surfacing', () => {
  beforeEach(() => {
    mockRunQueryRows.mockReset();
  });

  it('surfaces a Map-key scan failure as `error` while still publishing the columns phase A found', async () => {
    mockRunQueryRows.mockImplementation(async ({ sql }) => {
      if (sql.includes('system.columns')) {
        return [{ name: 'LogAttributes', type: "Map(LowCardinality(String), String)" }];
      }
      if (sql.includes('mapKeys')) {
        throw new Error('Timeout exceeded: max_execution_time = 60');
      }
      return [];
    });

    const { result } = renderHook(() => useFieldDiscovery(config, timeRange));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toMatch(/LogAttributes/);
    // The column itself is still published (as a plain column field) even though its Map-key
    // scan failed — partial fields plus a visible error, never partial fields presented as
    // complete.
    expect(result.current.fields.some((f) => f.name === 'LogAttributes')).toBe(true);
  });

  it('leaves error null when every discovery phase succeeds', async () => {
    mockRunQueryRows.mockImplementation(async ({ sql }) => {
      if (sql.includes('system.columns')) {
        return [{ name: 'Body', type: 'String' }];
      }
      return [];
    });

    // Different table than the first test — module-level caching in FieldsContext.tsx keys on
    // datasourceUid:database:table, so reusing the same table would silently reuse the first
    // test's cached (Map-typed) column instead of exercising this test's own mock.
    const { result } = renderHook(() => useFieldDiscovery({ ...config, logsTable: 'plain_logs' }, timeRange));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
  });
});
