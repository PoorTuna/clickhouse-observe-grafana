# Changelog

All notable changes to this project will be documented here.

Versions track the plugin's release history. `Unreleased` collects commits not yet tagged.

---

## [Unreleased]

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

[Unreleased]: https://github.com/PoorTuna/clickhouse-grafana/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/PoorTuna/clickhouse-grafana/releases/tag/v0.1.0
