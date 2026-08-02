/**
 * Regression coverage for the histogram-truncation bug: buildVolumeQuery's execution guardrail
 * used to pair `timeout_overflow_mode = 'break'` with `max_rows_to_read` / `read_overflow_mode =
 * 'break'`, which let ClickHouse silently return a partial GROUP BY aggregation instead of
 * erroring. Because the volume query's whole job is counting rows, a rows-read cap doesn't bound
 * cost — it just truncates the count, and truncated time buckets get zero-filled by
 * fillEmptyBuckets (VolumeHistogram.tsx) so they render identically to genuine no-data gaps. The
 * fix drops the rows-read cap and switches to `timeout_overflow_mode = 'throw'` so an over-budget
 * query fails loudly instead of rendering a confidently wrong histogram. See queryBuilder.ts's
 * VOLUME_QUERY_SETTINGS doc comment for the full writeup.
 */

import { buildVolumeQuery } from '../queryBuilder';
import { EMPTY_COLUMN_MAPPING, LogsQueryState, SourceConfig } from '../../types';

const config: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'my_table',
  isOtel: false,
  columns: { ...EMPTY_COLUMN_MAPPING, timestamp: 'ts' },
};

const state: LogsQueryState = { search: '', filters: [], rawSql: '', useRawSql: false, limit: 200, columns: [] };

describe('buildVolumeQuery execution guardrail', () => {
  it('throws on timeout instead of silently truncating the aggregation', () => {
    const sql = buildVolumeQuery(config, state, {
      interval: { unit: 'MINUTE', value: 1 },
      breakdown: { kind: 'none' },
    });
    expect(sql).toContain("timeout_overflow_mode = 'throw'");
  });

  it('carries no rows-read cap — counting rows is this query\'s job, so a cap only truncates the count', () => {
    const sql = buildVolumeQuery(config, state, {
      interval: { unit: 'MINUTE', value: 1 },
      breakdown: { kind: 'none' },
    });
    expect(sql).not.toContain('max_rows_to_read');
    expect(sql).not.toContain('read_overflow_mode');
    expect(sql).not.toContain("'break'");
  });

  it('applies the same guardrail across all three breakdown kinds (none/severity/field)', () => {
    const opts = { interval: { unit: 'MINUTE' as const, value: 1 } };
    const none = buildVolumeQuery(config, state, { ...opts, breakdown: { kind: 'none' } });
    const severity = buildVolumeQuery(config, state, { ...opts, breakdown: { kind: 'severity', expr: 'sev' } });
    const field = buildVolumeQuery(config, state, { ...opts, breakdown: { kind: 'field', expr: 'svc' } });
    for (const sql of [none, severity, field]) {
      expect(sql).toContain("timeout_overflow_mode = 'throw'");
      expect(sql).not.toContain('max_rows_to_read');
    }
  });
});
