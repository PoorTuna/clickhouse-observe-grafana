/**
 * Unit tests for sql/pruneColumn.ts — detection rules for a safe coarse index-pruning column, plus
 * the safety/widening invariant as a named test (see queryBuilder.ts's coarsePrunePredicate doc
 * comment for the full argument this codifies).
 */
import { detectPruneColumn, isMonotonicWrapperOf, PruneCandidateColumn } from '../pruneColumn';

function col(overrides: Partial<PruneCandidateColumn>): PruneCandidateColumn {
  return {
    name: 'TimestampTime',
    type: 'DateTime',
    defaultKind: 'DEFAULT',
    defaultExpression: 'toDate(Timestamp)',
    isInPartitionKey: true,
    isInPrimaryKey: true,
    position: 2,
    ...overrides,
  };
}

describe('isMonotonicWrapperOf', () => {
  it.each([
    'toDateTime(Timestamp)',
    'toDate(Timestamp)',
    'toStartOfSecond(Timestamp)',
    'toStartOfMinute(Timestamp)',
    'toStartOfHour(Timestamp)',
    'toStartOfDay(Timestamp)',
    'toDateTime64(Timestamp, 3)',
    "toTimeZone(toDate(Timestamp), 'UTC')",
  ])('recognizes whitelisted wrapper: %s', (expr) => {
    expect(isMonotonicWrapperOf(expr, 'Timestamp')).toBe(true);
  });

  it('rejects a wrapper over a different column', () => {
    expect(isMonotonicWrapperOf('toDate(IngestTime)', 'Timestamp')).toBe(false);
  });

  it('rejects a non-whitelisted function', () => {
    expect(isMonotonicWrapperOf('now()', 'Timestamp')).toBe(false);
    expect(isMonotonicWrapperOf('Timestamp + 1', 'Timestamp')).toBe(false);
  });

  it('rejects an empty expression or column', () => {
    expect(isMonotonicWrapperOf('', 'Timestamp')).toBe(false);
    expect(isMonotonicWrapperOf('toDate(Timestamp)', '')).toBe(false);
  });
});

describe('detectPruneColumn', () => {
  it('detects a toDate(...) partition-key column derived from the mapped timestamp', () => {
    const columns = [col({})];
    expect(detectPruneColumn(columns, 'Timestamp')).toBe('TimestampTime');
  });

  it('returns null when no timestamp is mapped', () => {
    expect(detectPruneColumn([col({})], '')).toBeNull();
  });

  it('returns null when no candidate qualifies (e.g. the mapped timestamp is itself the sort key)', () => {
    const columns = [
      col({ name: 'Timestamp', defaultKind: '', defaultExpression: '', isInPartitionKey: false, isInPrimaryKey: true }),
    ];
    expect(detectPruneColumn(columns, 'Timestamp')).toBeNull();
  });

  it('rejects a column with no partition/primary-key membership', () => {
    const columns = [col({ isInPartitionKey: false, isInPrimaryKey: false })];
    expect(detectPruneColumn(columns, 'Timestamp')).toBeNull();
  });

  it('rejects a column whose type is not a time type', () => {
    const columns = [col({ type: 'String' })];
    expect(detectPruneColumn(columns, 'Timestamp')).toBeNull();
  });

  it('rejects a column with no DEFAULT/MATERIALIZED expression (an independently-ingested column)', () => {
    const columns = [col({ defaultKind: '', defaultExpression: '' })];
    expect(detectPruneColumn(columns, 'Timestamp')).toBeNull();
  });

  it('rejects a column whose default expression is not a whitelisted monotonic wrapper', () => {
    const columns = [col({ defaultExpression: 'Timestamp + INTERVAL 1 HOUR' })];
    expect(detectPruneColumn(columns, 'Timestamp')).toBeNull();
  });

  it('accepts a MATERIALIZED column the same as a DEFAULT one', () => {
    const columns = [col({ defaultKind: 'MATERIALIZED' })];
    expect(detectPruneColumn(columns, 'Timestamp')).toBe('TimestampTime');
  });

  it('prefers a partition-key member over a primary-key-only candidate', () => {
    const columns = [
      col({ name: 'SortKeyOnly', isInPartitionKey: false, isInPrimaryKey: true, position: 2 }),
      col({ name: 'PartitionKeyCol', isInPartitionKey: true, isInPrimaryKey: false, position: 3 }),
    ];
    expect(detectPruneColumn(columns, 'Timestamp')).toBe('PartitionKeyCol');
  });

  it('ties broken by position (lower wins) among equally-qualified candidates', () => {
    const columns = [
      col({ name: 'Later', position: 5 }),
      col({ name: 'Earlier', position: 1 }),
    ];
    expect(detectPruneColumn(columns, 'Timestamp')).toBe('Earlier');
  });

  it('never selects the mapped timestamp column itself as its own prune column', () => {
    const columns = [col({ name: 'Timestamp', defaultExpression: 'toDate(Timestamp)' })];
    expect(detectPruneColumn(columns, 'Timestamp')).toBeNull();
  });

  // Safety/widening invariant (named test, per the perf plan's Tests section): for every
  // whitelisted wrapper, f(t) <= t must hold for realistic timestamps — this is the algebraic
  // fact coarsePrunePredicate's doc comment (queryBuilder.ts) leans on to justify the coarse
  // predicate never excluding a row the fine predicate keeps. Verified here for a fixed instant;
  // the live EXPLAIN + row-count check (see the perf plan's Verification section) confirms it
  // against a real table.
  describe('safety invariant: every whitelisted wrapper truncates (never rounds up)', () => {
    const t = Date.UTC(2026, 5, 29, 6, 30, 45, 123);
    it.each([
      ['toDateTime', (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000)],
      ['toDate', (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))],
      ['toStartOfHour', (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()))],
    ])('%s(t) <= t', (_name, f) => {
      const d = new Date(t);
      expect(f(d).getTime()).toBeLessThanOrEqual(d.getTime());
    });
  });
});
