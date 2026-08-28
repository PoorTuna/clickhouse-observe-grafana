/**
 * useFieldDiscovery covers three phases: A (system.columns), B (Tuple elements, parsed from A's own
 * type strings) and C (paths inside native JSON columns, one distinctJSONPaths query per column).
 * Map keys are the deliberate omission — they stay on-demand in FieldKeysPopover, because listing
 * them always costs a scan of row data, while Phase C's query is answered from part metadata.
 *
 * Note the module-level caches survive between tests in this file, so each test uses its own
 * logsTable name rather than trying to clear them.
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

describe('useFieldDiscovery — columns (Phase A)', () => {
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
    // Map-key discovery does not run here — a Map column is published only as itself
    // (source: 'column'), never expanded into per-key fields.
    expect(result.current.fields.every((f) => f.source === 'column')).toBe(true);
    expect(mockRunQueryRows).toHaveBeenCalledTimes(1);
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

// ── JSON paths (Phase C) — one distinctJSONPaths query per JSON column, published as fields ──
describe('useFieldDiscovery — JSON paths', () => {
  beforeEach(() => {
    mockRunQueryRows.mockReset();
  });

  function mockSchema(columns: Array<{ name: string; type: string }>, paths: Record<string, string[]>) {
    mockRunQueryRows.mockImplementation(async ({ sql }) => {
      if (sql.includes('system.columns')) {
        return columns;
      }
      const col = Object.keys(paths).find((c) => sql.includes(`distinctJSONPaths(${c})`));
      if (col) {
        return [{ paths: JSON.stringify(paths[col]) }];
      }
      return [];
    });
  }

  it('publishes each discovered path as a first-class field, typed from the declared JSON(...) paths', async () => {
    mockSchema(
      [
        { name: 'Body', type: 'String' },
        { name: 'Payload', type: 'JSON(user.id UInt32, max_dynamic_paths=8)' },
      ],
      { Payload: ['user.id', 'user.name'] }
    );

    const { result } = renderHook(() => useFieldDiscovery({ ...config, logsTable: 'json_table' }, timeRange));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const jsonFields = result.current.fields.filter((f) => f.source === 'json');
    expect(jsonFields).toEqual([
      expect.objectContaining({
        id: 'json:Payload:user.id',
        name: 'user.id',
        displayName: 'Payload.user.id',
        sqlExpr: 'Payload.user.id',
        type: 'number',
        jsonColumn: 'Payload',
        jsonPath: 'user.id',
      }),
      // Dynamic path: no declared type, so it falls back to 'string'.
      expect.objectContaining({ id: 'json:Payload:user.name', type: 'string' }),
    ]);
    // The container column stays in `fields` — LogDetailDrawer derives its JSON-column list from it.
    expect(result.current.fields.some((f) => f.source === 'column' && f.type === 'json')).toBe(true);
  });

  it('quotes a path segment that is not a bare identifier', async () => {
    mockSchema([{ name: 'Payload', type: 'JSON' }], { Payload: ['user-id'] });

    const { result } = renderHook(() => useFieldDiscovery({ ...config, logsTable: 'json_escape_table' }, timeRange));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.fields.find((f) => f.source === 'json')!.sqlExpr).toBe('Payload."user-id"');
  });

  it('reports a failing column but still publishes every other field', async () => {
    mockRunQueryRows.mockImplementation(async ({ sql }) => {
      if (sql.includes('system.columns')) {
        return [
          { name: 'Body', type: 'String' },
          { name: 'Payload', type: 'JSON' },
        ];
      }
      throw new Error('Timeout exceeded: max_execution_time = 25');
    });

    const { result } = renderHook(() => useFieldDiscovery({ ...config, logsTable: 'json_fail_table' }, timeRange));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toMatch(/Payload/);
    expect(result.current.fields.map((f) => f.name)).toEqual(['Body', 'Payload']);
  });

  it('does not re-query paths when the time range changes (the query is time-independent)', async () => {
    mockSchema([{ name: 'Payload', type: 'JSON' }], { Payload: ['a'] });

    const { result, rerender } = renderHook(
      ({ tr }: { tr: TimeRange }) => useFieldDiscovery({ ...config, logsTable: 'json_cache_table' }, tr),
      { initialProps: { tr: timeRange } }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    const callsAfterFirstLoad = mockRunQueryRows.mock.calls.length;

    rerender({
      tr: {
        from: dateTime('2026-02-02T00:00:00Z'),
        to: dateTime('2026-02-02T06:00:00Z'),
        raw: { from: 'now-6h', to: 'now' },
      },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockRunQueryRows.mock.calls.filter((c) => c[0].sql.includes('distinctJSONPaths'))).toHaveLength(1);
    expect(mockRunQueryRows.mock.calls.length).toBe(callsAfterFirstLoad);
  });
});

// ── Tuple elements (Phase B) — synchronous parse from system.columns' own type string, no scan ──
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
