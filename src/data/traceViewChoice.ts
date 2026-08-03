/**
 * Resolves an inbound trace->logs link's `dsUid` (a ClickHouse *datasource* uid) to one of our
 * *Data Views* (a saved database+table+column-mapping config on top of a datasource) — and
 * remembers the answer per datasource so the same jump doesn't ask twice.
 *
 * The mapping is inherently ambiguous: one datasource commonly backs several Data Views (e.g.
 * `otel_logs` and `app_logs` on the same ClickHouse connection — nothing in dataViews.ts enforces
 * uniqueness), and the trace context has no way to say which table the user wants. When more than
 * one view matches (or none do), the caller (App.tsx) shows a picker instead of guessing.
 */
import { DataView } from '../types';

const REMEMBERED_CHOICE_KEY = 'poortuna-clickhouse-observe:trace-view-choice';

export type TraceLanding =
  | { status: 'none' }
  | { status: 'resolved'; viewId: string }
  | { status: 'choosing'; dsUid: string; matching: DataView[]; others: DataView[]; reason: 'ambiguous' | 'no-match' };

/**
 * `views` should be the full merged list (shared + personal) so a stale remembered id can be
 * checked for continued existence.
 */
export function resolveTraceLanding(
  views: DataView[],
  dsUid: string | undefined,
  remembered: string | null
): TraceLanding {
  if (!dsUid) {
    return { status: 'none' };
  }

  const candidates = views.filter((v) => v.datasourceUid === dsUid);

  if (candidates.length === 0) {
    return { status: 'choosing', dsUid, matching: [], others: views, reason: 'no-match' };
  }

  if (candidates.length === 1) {
    return { status: 'resolved', viewId: candidates[0].id };
  }

  // A remembered choice only counts if it's still one of the current candidates — a view can be
  // renamed to point at a different datasource, or deleted, since the preference was stored.
  if (remembered && candidates.some((v) => v.id === remembered)) {
    return { status: 'resolved', viewId: remembered };
  }

  // Trace-capable views (a mapped traceId column) first, so the ones that can actually render
  // the filter pill are what the picker leads with.
  const matching = candidates.filter((v) => v.columns.traceId);
  const others = candidates.filter((v) => !v.columns.traceId);
  return { status: 'choosing', dsUid, matching, others, reason: 'ambiguous' };
}

function readRemembered(): Record<string, string> {
  try {
    const raw = localStorage.getItem(REMEMBERED_CHOICE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeRemembered(map: Record<string, string>): void {
  try {
    localStorage.setItem(REMEMBERED_CHOICE_KEY, JSON.stringify(map));
  } catch {
    // Storage full or unavailable — silently swallow, same as dataViews.ts.
  }
}

/** The Data View id previously chosen for this datasource uid, or null if never set/unavailable. */
export function getRememberedView(dsUid: string): string | null {
  return readRemembered()[dsUid] ?? null;
}

export function rememberView(dsUid: string, viewId: string): void {
  writeRemembered({ ...readRemembered(), [dsUid]: viewId });
}

export function forgetRememberedView(dsUid: string): void {
  const map = readRemembered();
  delete map[dsUid];
  writeRemembered(map);
}
