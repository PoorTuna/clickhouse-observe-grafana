/**
 * Field discovery (Phase B/C in FieldsContext.tsx) used to fire one scan query per Map/JSON
 * column via a plain Promise.all — unbounded concurrency. runWithConcurrencyLimit staggers that
 * to at most N in flight at once (see DISCOVERY_CONCURRENCY), without changing which columns get
 * discovered or the per-query result.
 */
import { runWithConcurrencyLimit } from '../FieldsContext';

describe('runWithConcurrencyLimit', () => {
  it('never runs more than `limit` items concurrently', async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await runWithConcurrencyLimit(items, 3, async (i) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return i;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('resolves all items, preserving input order in the output', async () => {
    const items = [5, 1, 4, 2, 3];
    const result = await runWithConcurrencyLimit(items, 2, async (i) => {
      await new Promise((r) => setTimeout(r, i));
      return i * 10;
    });
    expect(result).toEqual([50, 10, 40, 20, 30]);
  });

  it('handles limit >= items.length (falls back to full parallelism)', async () => {
    const items = [1, 2, 3];
    const result = await runWithConcurrencyLimit(items, 10, async (i) => i);
    expect(result).toEqual([1, 2, 3]);
  });

  it('handles an empty item list', async () => {
    const result = await runWithConcurrencyLimit([], 4, async (i) => i);
    expect(result).toEqual([]);
  });
});
