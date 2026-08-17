/**
 * useFieldDiscovery is now Phase A only (system.columns) — Map-key/JSON-path discovery (formerly
 * Phase B/C) was deleted from the mount-time hot path (see the perf plan's "Delete the presence
 * query and its Available/Empty machinery"). Attribute keys are now derived from hydrated rows
 * (sql/rowFields.ts) instead of a dedicated scan, so there is no more per-column mapKeys/jsonPaths
 * failure banner to test — a Phase A (system.columns) failure is the only failure mode left.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { useFieldDiscovery } from '../FieldsContext';
import { runQueryRows } from '../../data/runQuery';
import { DEFAULT_SOURCE_CONFIG, OTEL_COLUMN_MAPPING, SourceConfig } from '../../types';
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

describe('useFieldDiscovery — Phase A only', () => {
  beforeEach(() => {
    mockRunQueryRows.mockReset();
  });

  it('publishes discovered columns from system.columns', async () => {
    mockRunQueryRows.mockImplementation(async ({ sql }) => {
      if (sql.includes('system.columns')) {
        return [
          { name: 'Timestamp', type: 'DateTime64(9)' },
          { name: 'Body', type: 'String' },
          { name: 'LogAttributes', type: 'Map(LowCardinality(String), String)' },
        ];
      }
      return [];
    });

    const { result } = renderHook(() => useFieldDiscovery(config, timeRange));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.fields.map((f) => f.name).sort()).toEqual(['Body', 'LogAttributes', 'Timestamp']);
    // Map/JSON key/path discovery no longer runs here — a Map column is published only as itself
    // (source: 'column'), never expanded into per-key fields the way Phase B used to.
    expect(result.current.fields.every((f) => f.source === 'column')).toBe(true);
  });

  it('surfaces a system.columns failure as `error`, with no fields published', async () => {
    mockRunQueryRows.mockImplementation(async ({ sql }) => {
      if (sql.includes('system.columns')) {
        throw new Error('Timeout exceeded: max_execution_time = 25');
      }
      return [];
    });

    const { result } = renderHook(() =>
      useFieldDiscovery({ ...config, logsTable: 'failing_table' }, timeRange)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toMatch(/Timeout exceeded/);
    expect(result.current.fields).toHaveLength(0);
  });

  it('leaves error null when discovery succeeds', async () => {
    mockRunQueryRows.mockImplementation(async ({ sql }) => {
      if (sql.includes('system.columns')) {
        return [{ name: 'Body', type: 'String' }];
      }
      return [];
    });

    const { result } = renderHook(() =>
      useFieldDiscovery({ ...config, logsTable: 'plain_logs' }, timeRange)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
  });
});

// ── Tuple elements (Phase D) — synchronous parse from system.columns' own type string, no scan ──
describe('useFieldDiscovery — tuple elements still derived synchronously', () => {
  beforeEach(() => {
    mockRunQueryRows.mockReset();
  });

  it('flattens a Tuple-typed column into per-element fields without an extra query', async () => {
    mockRunQueryRows.mockImplementation(async ({ sql }) => {
      if (sql.includes('system.columns')) {
        return [{ name: 'MyTuple', type: 'Tuple(a String, b Int64)' }];
      }
      return [];
    });

    const { result } = renderHook(() =>
      useFieldDiscovery({ ...config, logsTable: 'tuple_table' }, timeRange)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    const tupleFields = result.current.fields.filter((f) => f.source === 'tuple');
    expect(tupleFields.map((f) => f.name).sort()).toEqual(['a', 'b']);
    // Exactly one query fired (system.columns) — no per-tuple scan.
    expect(mockRunQueryRows).toHaveBeenCalledTimes(1);
  });
});

// ── Coarse index-pruning column auto-detection (perf plan item 0) ────────────────────────────
describe('useFieldDiscovery — detectedPartitionTimestamp', () => {
  beforeEach(() => {
    mockRunQueryRows.mockReset();
  });

  it('detects a toDate(...) partition-key column derived from the mapped timestamp', async () => {
    mockRunQueryRows.mockImplementation(async ({ sql }) => {
      if (sql.includes('system.columns')) {
        return [
          { name: 'Timestamp', type: 'DateTime64(9)', default_kind: '', default_expression: '', is_in_partition_key: 0, is_in_primary_key: 0, position: 1 },
          { name: 'TimestampTime', type: 'DateTime', default_kind: 'DEFAULT', default_expression: 'toDate(Timestamp)', is_in_partition_key: 1, is_in_primary_key: 1, position: 2 },
        ];
      }
      return [];
    });

    const { result } = renderHook(() =>
      useFieldDiscovery(
        { ...config, logsTable: 'prune_detect_table', columns: OTEL_COLUMN_MAPPING },
        timeRange
      )
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.detectedPartitionTimestamp).toBe('TimestampTime');
  });

  it('detects nothing when no column qualifies (e.g. the mapped timestamp is itself the sort key)', async () => {
    mockRunQueryRows.mockImplementation(async ({ sql }) => {
      if (sql.includes('system.columns')) {
        return [
          { name: 'Timestamp', type: 'DateTime64(9)', default_kind: '', default_expression: '', is_in_partition_key: 0, is_in_primary_key: 1, position: 1 },
        ];
      }
      return [];
    });

    const { result } = renderHook(() =>
      useFieldDiscovery(
        { ...config, logsTable: 'no_prune_table', columns: OTEL_COLUMN_MAPPING },
        timeRange
      )
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.detectedPartitionTimestamp).toBe('');
  });
});
