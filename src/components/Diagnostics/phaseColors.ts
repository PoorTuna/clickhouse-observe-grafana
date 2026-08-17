/**
 * Single source of truth for how each structural span "phase" (see diag/types.ts's SpanKind) is
 * labeled, explained, and colored — shared by Waterfall.tsx's bars and PhaseBreakdown.tsx's
 * stacked summary bar, so the two read as one vocabulary instead of two ad hoc palettes that could
 * silently drift apart. Query-op spans (`logs`, `volume`, …) are not phases — they're containers
 * that sum their children's time — and are handled separately by callers via `isPhaseKind`.
 */
import { GrafanaTheme2 } from '@grafana/data';
import { SpanKind } from '../../diag/types';

/**
 * Plain-language label for every `QueryOp` (diag/types.ts) — the raw op string (`'jsonPaths'`,
 * `'traceLink'`, `'wizardDatabases'`) is an internal identifier, not something a new engineer or
 * customer reading the rail should have to decode. Deliberately distinct wording from the group
 * action names LogsExplorer.tsx assigns ('Time range', 'Filters', 'Search', 'Sort', 'Columns') —
 * `columns` (this op, sidebar field-list discovery) would otherwise collide with the 'Columns'
 * action name (a grid column edit), two different things that happen to share a word.
 */
const QUERY_OP_LABELS: Partial<Record<SpanKind, string>> = {
  logs: 'Log rows',
  volume: 'Histogram',
  detailPage: 'Detail page load',
  detailRow: 'Detail row lookup',
  loadMore: 'Load more rows',
  columns: 'Column discovery',
  mapKeys: 'Map key discovery',
  jsonPaths: 'JSON path discovery',
  fieldValues: 'Field autocomplete',
  traceLink: 'Trace link lookup',
  wizardDatabases: 'Data view setup: databases',
  wizardTables: 'Data view setup: tables',
  wizardColumns: 'Data view setup: columns',
  wizardJsonPaths: 'Data view setup: JSON paths',
};

/** What each query op is for — shown as a tooltip on the plain-language label above. */
const QUERY_OP_HINTS: Partial<Record<SpanKind, string>> = {
  logs: 'Fetches the rows shown in the log table.',
  volume: 'Fetches counts for the histogram above the table.',
  detailPage: 'Loads the page of rows around an opened row, for prev/next navigation.',
  detailRow: 'Looks up the single row shown in the detail drawer.',
  loadMore: 'Fetches the next page of rows for infinite scroll.',
  columns: 'Discovers which columns exist, for the sidebar field list.',
  mapKeys: 'Discovers keys inside Map-typed columns, for the sidebar.',
  jsonPaths: 'Discovers JSON paths inside JSON-typed columns, for the sidebar.',
  fieldValues: "Looks up autocomplete suggestions and a field's top values.",
  traceLink: 'Checks whether a trace datasource can resolve this row, to show "View trace".',
  wizardDatabases: 'Lists databases while setting up a data view.',
  wizardTables: 'Lists tables while setting up a data view.',
  wizardColumns: 'Lists columns while setting up a data view.',
  wizardJsonPaths: 'Discovers JSON paths while setting up a data view.',
};

export type PhaseKind = 'clickhouse' | 'transport' | 'decode' | 'render' | 'build';

export const PHASE_KINDS: readonly PhaseKind[] = ['clickhouse', 'transport', 'decode', 'render', 'build'];

export function isPhaseKind(kind: SpanKind): kind is PhaseKind {
  return (PHASE_KINDS as readonly string[]).includes(kind);
}

/** Long label shown inline next to a phase span's name in the waterfall — plain-language, always
 *  visible, no hover required (see the original "decode and transport are a bit ambiguous"
 *  feedback this exists to address). */
export const PHASE_LABELS: Record<PhaseKind, string> = {
  clickhouse: 'clickhouse (server execution)',
  transport: 'transport (network round-trip)',
  decode: 'decode (parse response)',
  render: 'render (UI paint)',
  build: 'build (SQL assembly)',
};

/** Short label for the phase-breakdown legend and rail-adjacent chrome, where the long form
 *  doesn't fit. */
export const PHASE_SHORT_LABELS: Record<PhaseKind, string> = {
  clickhouse: 'ClickHouse',
  transport: 'Network',
  decode: 'Decode',
  render: 'Render',
  build: 'Build',
};

/** Longer explanation shown as a tooltip — what this phase actually measures, for a reader with no
 *  context on this plugin's internal span model. */
export const PHASE_HINTS: Record<PhaseKind, string> = {
  transport:
    'Time between sending the request and ClickHouse starting execution — network + Grafana proxy overhead, not ClickHouse itself.',
  clickhouse: "Time ClickHouse itself spent running the query, from system.query_log's query_duration_ms.",
  decode: 'Time spent turning the HTTP response into table rows in the browser, after ClickHouse already answered.',
  render: 'Time from rows being committed to React until the browser actually painted them on screen.',
  build: 'Time spent assembling the SQL string before it was sent to ClickHouse.',
};

type VizHue = 'blue' | 'orange' | 'green' | 'purple';

const PHASE_HUES: Record<Exclude<PhaseKind, 'build'>, VizHue> = {
  clickhouse: 'blue',
  transport: 'orange',
  decode: 'green',
  render: 'purple',
};

/** The color for one phase, theme-aware via `theme.visualization`'s named hue palette. `build` gets
 *  a plain muted gray rather than a fifth saturated hue — it's the lowest-signal phase (a couple of
 *  milliseconds assembling a SQL string) and doesn't need to compete visually with the four that
 *  actually answer "was it ClickHouse or everything else". */
export function phaseColor(theme: GrafanaTheme2, kind: PhaseKind): string {
  if (kind === 'build') {
    return theme.colors.text.disabled;
  }
  return theme.visualization.getColorByName(PHASE_HUES[kind]);
}

/** Display label for any span: the phase label for a phase kind, the plain-language op label for a
 *  query-op kind, its own `name` otherwise (a user-gesture action like "Search" or "Time range" —
 *  already plain language, nothing to translate). */
export function labelForKind(kind: SpanKind, name: string): string {
  if (isPhaseKind(kind)) {
    return PHASE_LABELS[kind];
  }
  return QUERY_OP_LABELS[kind] ?? name;
}

/** Tooltip text for any span, same fallback rule as `labelForKind`. */
export function tooltipForKind(kind: SpanKind, name: string): string {
  if (isPhaseKind(kind)) {
    return PHASE_HINTS[kind];
  }
  return QUERY_OP_HINTS[kind] ?? name;
}
