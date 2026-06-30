# Changelog

All notable changes to this project will be documented here.

Versions track the plugin's release history. `Unreleased` collects commits not yet tagged.

---

## [Unreleased]

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

[Unreleased]: https://github.com/PoorTuna/clickhouse-grafana/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/PoorTuna/clickhouse-grafana/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/PoorTuna/clickhouse-grafana/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/PoorTuna/clickhouse-grafana/releases/tag/v0.1.0
