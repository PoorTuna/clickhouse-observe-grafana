# Changelog

All notable changes to this project will be documented here.

Versions track the plugin's release history. `Unreleased` collects commits not yet tagged.

---

## [Unreleased]

---

## [0.2.15] — 2026-07-08

### Fixed

- **"Add to dashboard" histogram panel was unreadable.** The exported "Log volume" panel used
  Grafana's `barchart` panel type, which treats every row as a discrete category — with ~50-60
  time buckets that produced one raw-epoch tick per bucket, all overlapping, plus ungrouped
  side-by-side (not stacked) bars. Switched to the `timeseries` panel type (rendered as stacked
  bars via `drawStyle`/`stacking`), which has a real time axis and renders exactly like the live
  in-app histogram.

---

## [0.2.14] — 2026-07-08

### Added

- **Native ClickHouse `JSON`-column fields.** Paths inside `JSON`-typed columns (type-hinted and
  dynamic) are now discovered alongside `Map` keys and surfaced as first-class fields — sidebar,
  KQL autocomplete, filters, and column selection all work the same way they already did for Map
  attributes.
- **Collapsible JSON tree in the log detail drawer.** The JSON tab now renders a Kibana-style
  per-node collapsible tree instead of a flat `JSON.stringify` dump.

### Fixed

- **OTel log detail drawer could crash on real data.** `parseMapValue` passed non-string Map/JSON
  attribute values (nested objects/arrays) straight through; rendering one as a React child threw.
  Values are now stringified consistently at parse time.
- **Severity breakdown silently reset to "No breakdown" after a full page reload.** `config`
  hydrates asynchronously, so the histogram breakdown's initial state was often set before
  `caps.hasSeverity` was known. It now self-corrects once capabilities are known, without ever
  overriding an explicit user choice.
- **Histogram hid small counts next to large ones** (e.g. 10 errors against 40k info logs) —
  every non-zero stacked segment now has a minimum render height, so a rare error/warn series is
  never invisible against a dominant one.
- **Histogram tooltip could get clipped off the right edge of the screen** when hovering buckets
  near the end of the chart — it now flips to the left of the cursor instead of overflowing.
- **Histogram didn't render empty buckets** — filtering to a range with sparse data (e.g. a full
  day with a quiet stretch) now shows flat-zero bars for the gap instead of omitting it.
- Discovered Map/JSON fields (e.g. `k8s.namespace.name`) showed as bare, unprefixed names in the
  sidebar and search-bar autocomplete, making them indistinguishable from real top-level columns.
  They're now labeled with their source column (`ResourceAttributes.k8s.namespace.name`) and
  grouped under a collapsible header per source column in the sidebar; filtering/selecting the
  raw container column itself still works from the same header row.

### Changed

- Nested Map/JSON fields in the sidebar are collapsed by default (a table can have hundreds of
  discovered keys/paths) — expand a source column's group to see its fields, or just search.

---

## [0.2.13] — 2026-07-07

### Fixed

- **Nav links broken on Grafana < 10.3 (and some airgapped installs).** `plugin.json` used the
  `%PLUGIN_ID%` template placeholder in `includes[].path`; that substitution requires a Grafana
  version newer than this plugin's declared `>=10.0.0` minimum, so older instances rendered the
  literal string (`/a/%PLUGIN_ID%/logs`) instead of a working URL. Paths now hardcode the plugin
  ID directly.

### Changed

- Retook the three README screenshots (Logs Explorer, Trace Explorer, Configuration) against
  live seeded data.

---

## [0.2.12] — 2026-07-07

### Changed

- **Logs Explorer list query no longer sends `SELECT *`.** The grid query now projects only the
  columns it renders; the detail drawer lazily fetches the full row (Map attribute columns,
  "All fields", JSON tab) per page on first open, matched to the grid row by content key
  (timestamp+body+severity+service) rather than row offset, so it can never attach the wrong
  row's attributes. Raw-SQL mode is unaffected — those rows already carry whatever the user's
  own query selected. Cuts the data transferred per page/load-more substantially on tables with
  large `Map(String,String)` columns (e.g. OTel `ResourceAttributes`/`LogAttributes`/
  `ScopeAttributes`).

---

## [0.2.11] — 2026-07-07

### Fixed

- Cleared all 30 ESLint errors surfaced by the new hooks lint rules: hook-order bugs (state
  declared after use in `LogsExplorer`, `CreateDataViewModal`), a real `react-hooks/rules-of-hooks`
  violation in `VolumeHistogram` (a `useMemo` sat after an early `return null`), a ref read
  during render in the histogram's hover-band logic, and ten `set-state-in-effect` cases —
  converted synchronous datasource-list reads to lazy `useState` init, scoped-disabled genuine
  async-fetch/external-sync effects with justification comments.
- Fixed `App.tsx`'s `jsonData` fallback recreating a new object every render, which silently
  broke the `sharedViews` memoization.

---

## [0.2.10] — 2026-07-07

### Changed

- **Log detail drawer overhaul** — rebuilt as an Elastic-Discover-style document view: sticky
  header summary (time, severity, service, prev/next navigation), `Table` / `JSON` tabs, a real
  two-column field/value layout (long field names now wrap cleanly instead of breaking
  mid-word), a "selected only" filter, and select-text-in-log-line → "line contains" filtering.
- **Logs table polish** — per-row severity color stripe, UI-font headers (was monospace), a
  wrap-lines toggle, `↑`/`↓`/`Enter` keyboard navigation, and proper loading/empty states.
- **Volume histogram** — added a y-axis scale, horizontal gridlines, several x-axis time ticks
  (previously just two bare endpoint labels), and a legend in severity mode.
- Search bar autocomplete badges relabeled from single letters to readable short labels.

### Fixed

- The Log explorer page now scrolls only within the log table, not the whole page — it never
  adopted the `useAvailableHeight` fix already used by the Traces page for the same Grafana
  `PageLayoutType.Custom` chrome quirk.
- "Edit as SQL" no longer sends an empty query when first opened, no longer re-runs the query on
  every keystroke, and no longer fires an extra request just from toggling the mode on — typing
  is local until you click **Run query** or press **Ctrl+Enter**.
- The raw-SQL toggle button's label no longer reads as two different actions ("Edit as SQL" /
  "Edit SQL") — now a clear "Edit as SQL" / "Back to query builder" pair.

---

## [0.2.9] — 2026-07-05

### Added

- **Traces explorer** — a new OTel-native trace view: waterfall (virtualized span tree),
  service map, per-trace header stats, and a span detail drawer with events/links/attributes.
  Correlates from a log row to its trace, and from a span back to its surrounding logs.

### Fixed

- `buildLogsByTraceIdQuery` now bails out (returns an empty query) when `timestamp` or `body`
  isn't mapped, instead of interpolating `undefined` into the SQL.
- `resolveVolumeBreakdown` falls back to no breakdown when `severity` isn't mapped, instead of
  emitting `lower(toString())` with an empty expression.
- The trace detail view no longer discards span/resource attributes — the drawer's "Span
  Attributes" and "Resource Attributes" sections were always empty due to a row-mapping bug.
- `LogsExplorer`'s default-columns resolver was typed to accept `any`, silently swallowing any
  future rename/typo on `SourceConfig.columns`; now typed properly.

### Removed

- Committed build artifacts and scratch recordings accidentally left in the working tree.

---

## [0.2.8] — 2026-07-04

### Fixed

- **Core column aliases can no longer collide with a real column on an arbitrary table** —
  `buildLogsQuery`'s fixed columns (timestamp/body/severity/traceId/spanId/serviceName) are now
  aliased under `__`-prefixed names (`__timestamp`, `__severity`, ...) instead of their plain
  field name. Previously, if a table happened to have its own unrelated column literally named
  e.g. `severity` (distinct from whatever was mapped to that role), the query would emit two
  output columns with the same name — silently losing one via last-column-wins overwrite, or for
  `timestamp`/`body` specifically, failing outright with an ambiguous `ORDER BY`. This can no
  longer happen since a `__`-prefixed alias can't coincide with a real column name.
- Removed the `ResourceAttributes`/`LogAttributes`/`ScopeAttributes` aliases from
  `buildLogsQuery` entirely — dead code; the attribute-group UI already reads by the raw mapped
  column name, never by that alias.

### Note

- If you had manually reordered or removed one of the 4 default log columns, that customization
  is keyed by the old alias name and will silently stop applying after this update — just
  re-toggle the column from the field sidebar. No data loss, cosmetic only.

---

## [0.2.7] — 2026-07-04

### Fixed

- **Query builders no longer emit `undefined`/duplicate columns for unmapped fields on
  arbitrary tables** — `buildLogsQuery`'s `severity`/`traceId`/`spanId`/`serviceName` phantom
  `'' AS x` fallbacks are now dropped entirely when unmapped (previously always emitted,
  risking a duplicate-column collision with `SELECT *` and an ambiguous `ORDER BY timestamp`
  on tables that happen to have a same-named column). `buildTraceSearchQuery` /
  `buildTraceDetailQuery` now gate on `traceId` and degrade unmapped fields to constants
  instead of interpolating `undefined`. `buildVolumeQuery`, `buildMapKeysQuery`, and
  `buildSurroundingDocsQuery` now gate on `timestamp` being mapped instead of assuming it.

---

## [0.2.6] — 2026-07-04

### Added

- **"Add to dashboard"** — export the Logs Explorer's current logs table and/or volume
  histogram as real Grafana panels onto a new or existing dashboard. Filters, search,
  columns, sort, and breakdown are baked into the exported SQL (via `$__fromTime`/
  `$__toTime`/`$__timeInterval` macros), so panels stay dashboard-time-relative instead of
  freezing the range at export time. Gated behind `dashboards:create` permission.
- **Per-field descriptions in Column Mapping** — each mapping field now states what it
  actually enables (e.g. "Enables the trace-jump link…") instead of just a bare label.

### Changed

- **Removed the `severityNumber` mapping field** — it was never consumed by any SQL
  generation or rendering; a dead, confusing leftover from the OTel adaptation.
- **`grafana-clickhouse-datasource` declared as a plugin dependency** in `plugin.json`
  (previously only present in the built copy). Requires a Grafana server restart to apply.

### Fixed

- **Severity breakdown case-duplication in histogram queries** — mixed-case severity values
  (e.g. `ERROR` vs `error`) now normalize to lowercase in SQL (`lower(toString(...))`)
  instead of only in client-side rendering, so exported dashboard panels — which have no
  such client-side fold step — don't show duplicate legend entries per case variant.

---

## [0.2.5] — 2026-07-01

### Changed

- **Removed hardcoded field aliases** — KQL/filter field resolution no longer
  recognizes English synonym groups (`message`/`level`/`service`/`trace`/`span`
  and variants). Every typed field must match a real mapped column name, an
  already-qualified expression, or fall back to Map attribute lookup. No implicit
  vocabulary, on any schema — OTel included.
- **Removed hardcoded severity-level vocabulary** — the `error`/`warn`/`info`/…
  synonym expansion (`LOG_LEVEL_TO_IN_CLAUSE`) is gone along with the `level`
  alias that was its only caller. Severity queries now do plain exact/substring
  matching on the mapped column, same as any other field.
- **Trace queries no longer hardcode OTel column names** — `StatusCode`,
  `SpanName`, and `SpanId` were emitted as bare literals in trace detail/search
  queries regardless of the data view's mapping, breaking on non-OTel traces
  tables. Added `spanName` and `statusCode` to Column Mapping (mappable in the
  UI); `SpanId` now correctly uses the existing `spanId` mapping. Unmapped
  fields degrade to empty/zero instead of emitting a broken column reference.
- **`severityNumber` is now a real mapped column** instead of a hardcoded
  `isOtel`-gated literal — add it in Column Mapping (OTel preset fills it
  automatically) to enable numeric-severity queries on any schema.

### Fixed

- **`not <field> op value` on an unresolved field excluded all rows** —
  unresolved range comparisons (e.g. `not duration > 10` when `duration` wasn't
  mapped) emitted a `1=1` no-op sentinel that `NOT` flipped into "exclude
  everything," producing a false "No logs found." Range comparisons now fall
  back to the field name as a direct column, consistent with the `field:value`
  path, so real columns work even when not explicitly mapped.

---

## [0.2.4] — 2026-06-30

### Fixed

- **Timestamp picker accepted non-time columns** — "Create data view" timestamp
  dropdown now only lists columns with an actual `Date`/`Date32`/`DateTime`/
  `DateTime64(...)` type (including `Nullable(...)`/`LowCardinality(...)` wrapped),
  instead of suggesting time types first but allowing any column. Body field still
  accepts any column.
- **Empty log table when no timestamp mapped** — `ORDER BY timestamp` was hardcoded
  even when no timestamp column was mapped, causing the query to fail server-side and
  silently render "No logs found". Now omits `ORDER BY` entirely when there's no
  timestamp.

---

## [0.2.3] — 2026-06-30

### Changed

- **OTel is now explicit opt-in** — creating a data view no longer auto-infers the
  OpenTelemetry schema. A checkbox "Apply OpenTelemetry preset" replaces the silent
  auto-detect (`looksLikeOtelSchema`). OTel preset remains available via the checkbox
  and the "Apply OTel preset" button in advanced config.
- **Generic default config** — `DEFAULT_SOURCE_CONFIG` starts blank (`isOtel: false`,
  empty column mapping, no table names). The `isOtel` flag now means exactly one thing:
  the table has a `SeverityNumber` numeric column queryable by name in KQL.

### Fixed

- **Filter-pill unknown field** — fields not present in the column mapping now query
  the column directly (e.g. `"level" = 'info'`) instead of emitting broken
  `undefined ILIKE …` SQL. Matches the direct-column fallback added to the KQL path
  in v0.2.2.
- **Free-text search with no body column** — the legacy `hasToken` search path now
  returns an empty clause instead of `hasToken(undefined, …)` on tables without a
  mapped body column.

---

## [0.2.2] — 2026-06-30

### Fixed

- **Severity breakdown**: Severity option now only appears (and is only defaulted) when
  the mapped severity column actually exists in the real table schema — verified via
  `system.columns` introspection, not just the config mapping string. Stale severity
  selections auto-correct to "No breakdown" on view switch.
- **Distributed table 500 on field breakdown**: replaced `IN (SELECT v FROM top)` with
  `GLOBAL IN` — fixes _"double distributed in join"_ / _"set distributed_product_mode"_
  errors on Distributed-engine tables without requiring settings changes (works for
  read-only CH users too). Field-stats popover scalar subquery replaced with
  `sum(count()) OVER ()` window aggregate for the same reason.
- **"All fields" in log detail drawer**: `buildLogsQuery` now projects `SELECT *` so
  every table column is available in the row object; the drawer deduplicates mapped /
  aliased columns to avoid showing `Timestamp` and `timestamp` twice.
- **Empty cells for sidebar-added columns**: `makeColumnKey` prefix changed from `_f_`
  to `fld_` — the old prefix collided with the ClickHouse datasource's `_f_col_` Map
  column strip in `dataFrameToRows`, causing user-added columns to render blank.
- **Inspect SQL copy button**: falls back to `document.execCommand('copy')` when
  `navigator.clipboard` is unavailable (Grafana iframe / non-secure context).
- **TypeScript**: resolved all 10 pre-existing type errors — unused imports
  (`dateTimeFormat`, `IconButton`, `AttributeGroup`), unknown icon name `chart-bar`,
  `ConfirmModal` icon prop, unused variables (`totalHeight`, `totalCount`),
  `ds.query()` Observable/Promise union wrapping, stale `active` field in test fixtures.

---

## [0.2.1] — 2026-06-30

### Fixed

- Removed `dependencies.plugins` from `plugin.json` — Grafana was auto-resolving
  `grafana-clickhouse-datasource` from grafana.com at install time, which blocks
  installation on airgapped / offline Grafana instances. The ClickHouse datasource
  is now documented as a manual prerequisite in the README instead.

---

## [0.2.0] — 2026-06-30

### Added

#### Histogram interval + breakdown controls (Kibana parity)

Two controls sit in a header bar above the volume histogram, framed as a panel card:

- **Auto interval picker** — choose Auto (derived from time range), Second, Minute,
  Hour, Day, Week, or Month. Fine units are greyed out with a tooltip when they would
  produce more than 1 000 bars. Shows the resolved interval (e.g. "Auto - 30 minutes")
  in the header meta caption alongside the event count.
- **Breakdown picker** — searchable dropdown with three modes:
  - **No breakdown** — plain single-color bars (`#54B399`).
  - **Severity** (default when a severity column is mapped) — stacks bars by severity
    level using the existing `SEVERITY_COLORS` palette.
  - **Field breakdown** — choose any field; bars split into top-10 values + "Other"
    catch-all computed server-side via a CTE. Categorical palette + legend row below
    the chart.
- Severity is the **default when detected** (set once at mount / on data-view change);
  user's explicit choice (including "No breakdown") is never auto-reverted.

#### Panel framing for the histogram

The header bar + chart are wrapped in a single bordered card
(`border: 1px solid border.weak`, `border-radius`, `background.primary`) so the
controls read as the chart's title bar rather than a floating row. When no events
match the current query a "No events in selected time range" placeholder fills the
chart area at normal height.

#### Bucket hover highlight

Hovering a bucket shows a subtle full-height highlight band behind the bars at that
column (`theme.colors.action.hover`), matching Kibana Discover's bucket hover UX.
The band tracks the cursor, is hidden during drag-select, and clears on mouse leave.

#### New constants (`src/constants.ts`)
- `SINGLE_STACK_COLOR` — accent color for no-breakdown bars.
- `BREAKDOWN_PALETTE` — 10-color categorical palette for field breakdown.
- `OTHER_COLOR` — neutral grey for the "Other" series.

#### New types (`src/types.ts`)
- `IntervalMode` — `'auto' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'`
- `BreakdownSel` — discriminated union `{ kind: 'none' } | { kind: 'severity' } | { kind: 'field'; field: FieldModel }`

#### New components
- `src/components/HistogramControls/IntervalPicker.tsx`
- `src/components/HistogramControls/BreakdownPicker.tsx`

#### Query builder (`src/sql/queryBuilder.ts`)
`buildVolumeQuery` now accepts a typed `VolumeQueryOpts` object with explicit
`breakdown` discriminated union (`none` / `severity` / `field`). Field breakdown uses
a top-N CTE with server-side "Other" aggregation in a single round trip.

---

## [0.1.0] — 2026-06-30

### Added

#### Structured filter builder ("Add filter")
A **`+ Add filter`** button now sits in the Logs Explorer toolbar beside the KQL search bar.
Clicking it opens a popup panel (portal-positioned, click-outside to dismiss) with:

- **Field dropdown** — searchable, populated from `useFields()` (same source as KQL autocomplete:
  `system.columns` introspection plus Map-key discovery via `buildMapKeysQuery`).
- **Operator dropdown** — eight operators matching Kibana Discover's layout:
  `is`, `is not`, `is one of`, `is not one of`, `exists`, `does not exist`,
  `contains`, `does not contain`.
- **Value input** — autocompletes live top values from ClickHouse via the existing
  `loadFieldValues` / `buildFieldTopValuesQuery` pipeline. Multi-select for `is one of` /
  `is not one of`; hidden for `exists` / `does not exist`. Custom values can be typed directly.
- **Custom label** (optional) — overrides the default pill label displayed in the filter bar.

Submitting adds a removable filter pill below the toolbar. Query re-runs automatically.

#### Extended `FilterOp` + `FilterPill` types (`src/types.ts`)
`FilterOp` extended from 4 to 8 values: added `one_of`, `not_one_of`, `exists`, `not_exists`.
`FilterPill` gains two optional fields: `values?: string[]` (multi-value list for `one_of` /
`not_one_of`) and `label?: string` (custom display label). Backward-compatible — existing pills
with only `field`, `op`, `value` are unaffected.

#### New SQL clauses (`src/sql/queryBuilder.ts`)
`buildFilterClause` handles the four new operators:
- `exists` → `notEmpty(toString(<expr>))`  (reuses the pattern KQL emits for `field:*`)
- `not_exists` → `empty(toString(<expr>))`
- `one_of` → `<col> IN ('a', 'b', 'c')`
- `not_one_of` → `<col> NOT IN ('a', 'b', 'c')`

Empty `values[]` guards produce `1=0` / `1=1` rather than a syntax error.
Map-accessor fields (e.g. `LogAttributes['http.method']`) work with all operators.

#### `addFilterPill` helper (`src/sql/filters.ts`)
New function `addFilterPill(filters, pill)` dedupes by `field+op` and appends the pill
object as-is, preserving `values` and `label`. Replaces the previous `addFilter` call in
`LogsExplorer.tsx`'s `onAddFilter` handler, which would silently drop those fields.

`makeFilter` now accepts an optional `extras` argument (`{ values?, label? }`) so callers
building pills programmatically don't need a separate constructor.

`filterLabel` updated to produce human-readable labels for all eight operators plus custom-label
override.

#### Filter clause tests (`src/sql/__tests__/filter_clause.test.ts`)
31 unit tests covering:
- `exists` / `not_exists` on plain columns and Map-accessor fields
- `one_of` / `not_one_of` value quoting, SQL-special-char escaping, and empty-value guards
- Existing `=`, `!=`, `contains`, `not_contains` regressions
- `filterLabel` output for all new operators and custom-label override
- `addFilterPill` deduplication and pill-field preservation

#### Custom plugin icon (`src/img/logo.svg`, `plugin.json`)
Plugin icon updated to a ClickHouse-branded logo with a magnifying-glass overlay.

#### SQL inspect panel
"Inspect SQL" toggle in the Logs Explorer shows the exact ClickHouse query being executed,
with a one-click copy button.

---

## Project layout additions

| Path | Added in |
|------|----------|
| `src/components/AddFilter/AddFilterPopover.tsx` | 0.1.0 |
| `src/components/SavedSearches/` | 0.1.0 |
| `src/sql/__tests__/filter_clause.test.ts` | 0.1.0 |

---

[Unreleased]: https://github.com/PoorTuna/clickhouse-observe-grafana/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/PoorTuna/clickhouse-observe-grafana/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/PoorTuna/clickhouse-observe-grafana/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/PoorTuna/clickhouse-observe-grafana/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/PoorTuna/clickhouse-observe-grafana/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/PoorTuna/clickhouse-observe-grafana/releases/tag/v0.1.0
