/**
 * Encodes/decodes the Logs Explorer's shareable state (search, filters, columns, sort, time
 * range, active data view) to/from URL query params, so a link can be copied to a colleague and
 * reproduce the same view. Same field set Saved Searches already prove serializable (see
 * data/savedSearches.ts + SavedSearchMenu.tsx) — this just targets the URL instead of localStorage.
 *
 * Deliberately plain JSON in the query string (not base64) — URLSearchParams already percent-
 * encodes/decodes values for us, so there's nothing base64 buys here beyond a longer URL.
 */
import { dateTime, rangeUtil, TimeRange } from '@grafana/data';
import { FilterPill, SelectedColumn } from '../types';

export interface DecodedLogsUrlState {
  search?: string;
  filters?: FilterPill[];
  columns?: SelectedColumn[];
  sort?: { col: string; dir: 'asc' | 'desc' };
  timeRange?: TimeRange;
  viewId?: string;
  // traceId/dsUid: inbound-only fields carried by a trace->logs deep link from Grafana Explore's
  // ClickHouse trace view (see data/traceToLogsLink.ts) — a `traceId`/`dsUid` filter pill isn't
  // something a colleague reproduces by copying a Logs Explorer URL, so unlike every other field
  // here these are deliberately absent from EncodeLogsUrlStateInput/encodeLogsState below. Never
  // round-tripped, only consumed once at mount (App.tsx / LogsExplorer.tsx).
  traceId?: string;
  dsUid?: string;
}

export interface EncodeLogsUrlStateInput {
  search: string;
  filters: FilterPill[];
  columns: SelectedColumn[];
  sort?: { col: string; dir: 'asc' | 'desc' };
  timeRange: TimeRange;
  viewId?: string;
}

export function encodeLogsState(state: EncodeLogsUrlStateInput): URLSearchParams {
  const sp = new URLSearchParams();
  if (state.search.trim()) {
    sp.set('q', state.search);
  }
  if (state.filters.length > 0) {
    sp.set('filters', JSON.stringify(state.filters));
  }
  // Only encode a non-empty column set — an empty array means "use the view's default columns",
  // which is both the common case and avoids baking one user's exact grid layout into every link
  // a colleague opens against a possibly different (future) default.
  if (state.columns.length > 0) {
    sp.set('cols', JSON.stringify(state.columns));
  }
  if (state.sort) {
    sp.set('sort', `${state.sort.col}:${state.sort.dir}`);
  }
  // Preserve relative strings ('now-1h') so the link stays "last hour" for whoever opens it,
  // rather than freezing to the exact absolute range at copy time — same convention
  // SavedSearchMenu.tsx's handleSave uses.
  const from = typeof state.timeRange.raw.from === 'string' ? state.timeRange.raw.from : String(state.timeRange.from.valueOf());
  const to = typeof state.timeRange.raw.to === 'string' ? state.timeRange.raw.to : String(state.timeRange.to.valueOf());
  sp.set('from', from);
  sp.set('to', to);
  if (state.viewId) {
    sp.set('ds', state.viewId);
  }
  return sp;
}

function safeParseArray<T>(raw: string | null): T[] | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort — any field that fails to parse is simply omitted, never throws. */
export function decodeLogsState(searchParams: URLSearchParams): DecodedLogsUrlState {
  const result: DecodedLogsUrlState = {};

  const q = searchParams.get('q');
  if (q !== null) {
    result.search = q;
  }

  const filters = safeParseArray<FilterPill>(searchParams.get('filters'));
  if (filters) {
    result.filters = filters;
  }

  const cols = safeParseArray<SelectedColumn>(searchParams.get('cols'));
  if (cols) {
    result.columns = cols;
  }

  const sortRaw = searchParams.get('sort');
  if (sortRaw) {
    const [col, dir] = sortRaw.split(':');
    if (col && (dir === 'asc' || dir === 'desc')) {
      result.sort = { col, dir };
    }
  }

  const from = searchParams.get('from');
  const to = searchParams.get('to');
  if (from && to) {
    try {
      // Same convention as SavedSearchMenu.tsx's handleLoad: relative strings pass through for
      // dateMath to resolve, absolute epoch-ms strings become DateTime objects.
      const toRaw = (v: string) => (v.startsWith('now') ? v : dateTime(Number(v)));
      result.timeRange = rangeUtil.convertRawToRange({ from: toRaw(from), to: toRaw(to) });
    } catch {
      // Malformed from/to — leave timeRange undefined, caller keeps its own default.
    }
  }

  const ds = searchParams.get('ds');
  if (ds) {
    result.viewId = ds;
  }

  const traceId = searchParams.get('traceId');
  if (traceId) {
    result.traceId = traceId;
  }

  const dsUid = searchParams.get('dsUid');
  if (dsUid) {
    result.dsUid = dsUid;
  }

  return result;
}
