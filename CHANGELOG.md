# Changelog

All notable changes to this project will be documented here.

Versions track the plugin's release history. `Unreleased` collects commits not yet tagged.

---

## [Unreleased]

---

## [0.4.11] — 2026-08-12

### Changed

- Reworked the Logs Explorer histogram section: borderless toolbar buttons with a trailing chevron
  only, panel framed with a top/bottom rule instead of a boxed card, meta caption centered under
  the chart, wider y-axis gutter, px-accurate bar gaps, and a full vertical+horizontal gridline
  layout.
- Histogram legend now dims every non-hovered series' bars on hover.
- Added a chart collapse toggle to the histogram toolbar — collapses the chart while keeping the
  interval/breakdown pickers and their state.
- The results pane (histogram + table) now sits on a subtly different background than the fields
  sidebar, giving the two areas a clearer visual split.
- Field-type icons in the sidebar are now color-coded by type (time/number/string/boolean/map/
  json/etc.) instead of one flat gray, using Grafana's own visualization palette.
- Histogram meta line now reads "rows" instead of "documents" — this is ClickHouse, not
  Elasticsearch.

### Fixed

- **`SELECT *` was being double-selected.** The log-detail ("full") query aliased every mapped
  column a second time on top of its own `SELECT *`, duplicating the fetch cost for no reason —
  `logRowKey()` now reads either the grid's aliased shape or the full row's raw column names, so
  the full projection no longer needs the redundant aliases.
- **Auto-interval histogram bucketing collapsed to hairline bars on wide time ranges.** The
  bucket-size step table topped out at 1 day, so a multi-year range still bucketed by day (hundreds
  of near-empty bars) instead of scaling toward the ~60-bucket target; extended the step table out
  to yearly steps.
- **Histogram x-axis tick labels had inconsistent spacing** (and could duplicate/overlap into the
  legend) — ticks were picked by rounding a proportional index per label, which jitters between
  step sizes whenever the bucket count doesn't divide evenly; switched to a constant index step
  with edge-aware label anchoring.
- **Filter-pill context menu rendered at the viewport origin instead of under the clicked pill** —
  it read the anchor element's position from a ref in a layout effect, but the ref's callback
  identity changed every render and hadn't reattached yet on the mount that opened the menu. Now
  captures the pill's bounding rect at click time instead.

---

## [0.4.10] — 2026-08-09

### Fixed

- **KQL search bar deviated from real Kibana Query Language grammar in ways that silently produced wrong results.** Reported case: `.*xd something something with spaces.*` fanned out into five separate required (AND'd) clauses instead of being searched as one string, because the tokenizer split on every space. Real KQL treats whitespace as an ordinary character inside a value and has no implicit AND — brought the parser in line:
  - A value (bare term or `field:value`) now absorbs spaces instead of being split into multiple clauses — `os:windows 10` is one value `"windows 10"`, not two.
  - `and`/`or`/`not` must now be written explicitly between clauses, matching Kibana — `level:error service:pay` (no `and`) is a syntax error rather than a silently-inserted AND.
  - An invalid query is now refused with a Kibana-style "Expected X but Y found" message and caret shown under the search bar, instead of silently falling back to a raw-text body search with no indication anything was wrong. Results on screen are left as they were.
  - `?` is no longer treated as a wildcard — real KQL supports only `*`. A literal `?` (URLs, query strings) now matches itself instead of any single character.
  - A `field:value` whose field doesn't resolve to a real column (e.g. typing a colon-containing value like `http://x` or `12:30:45`, which reads as `field:value`) now falls back to a plain-text body search instead of emitting a broken SQL column reference that errored the whole query.
  - Added support for two more real KQL features: field-name wildcards (`datastream.*: logs` matches across every discovered field the wildcard covers) and typed `true`/`false`/`null` literals on unquoted values (`flag:true` now compares against a bare boolean instead of the string `'true'`).
  - Added `\uXXXX` unicode escapes, part of the documented grammar but previously unhandled (left a literal `u0041` in the value).
- **Quoted-phrase search (`Body:"..."`) had a SQL injection hole and silently broken regex escaping.** The generated `match()` regex pattern was interpolated into the query without ever being passed through the existing SQL-string quoting helper: an unescaped `'` in the search text could break out of the SQL string (e.g. searching `"x') OR 1=1 --"`), and single-backslash regex escapes were silently eaten by ClickHouse's own string-literal parser, so `Body:"req.id"` also matched `"reqXid"`. Both are fixed by building the regex pattern in JS and quoting it the same way every other value is quoted.
- The legacy free-text fallback path (used only when a query fails to parse as KQL) didn't escape literal `%`/`_` before using them in an `ILIKE` pattern, so those characters silently acted as SQL wildcards there while the normal KQL path already escaped them correctly.
- **A filter pill's field name could inject arbitrary SQL.** Filter pills round-trip through the URL and saved searches, so a crafted link could set `field` to something like `x) OR 1=1 -- (` and have it interpolated unquoted into the query — the identifier-quoting helper skipped quoting for any name containing `(`, `[`, or `.`, a loose heuristic meant to let already-built expressions (`Col['key']`, `Payload.user.id`) pass through, but applied identically to raw untyped text. Replaced with strict shape validation, and closed a second, more direct route to the same bug: the `exists`/`not_exists` filter operators didn't quote the field expression at all, regardless of the identifier-quoting fix.
- Discovered Map keys and JSON paths (populating the fields sidebar and filter autocomplete) were interpolated into SQL unescaped — a Map key containing `'`, or a JSON path segment that isn't a valid bare identifier (`user-id`, `k8s.io/name`), produced broken or silently different SQL instead of the intended field reference.
- `hasToken()` (used in free-text/body search) throws a ClickHouse error on any search term containing a separator character — `-`, `.`, `:`, `/`, or a space, all common in log search (`req-59`, `1.2.3.4`) — failing the whole search instead of matching. Removed: it was also redundant whenever it didn't throw, since the adjacent case-insensitive `ILIKE` match already covers everything a case-sensitive whole-token `hasToken` match could find.
- The ClickHouse datasource resolves (never rejects) its query response even when a query failed server-side — the failure surfaces via `DataQueryResponse.error`/`.errors` alongside an empty/partial result, not by throwing. Nothing in this plugin checked those fields, so every ClickHouse error (bad SQL, a query hitting its execution-time budget, permissions) silently looked like "0 results" instead of a catchable error — including every timeout guardrail already in this codebase, whose whole point was to fail loudly rather than return a wrong-looking answer. Fixed at the single chokepoint all queries run through.



## [0.4.8] — 2026-08-04

### Fixed

- Fields sidebar: hovering a field's row used to permanently reserve space for its filter/add-column icons on every row (even hidden), truncating the field name earlier than the sidebar's actual width allowed. Icons now only claim that space while actually revealed on hover, and no longer overlap the name text.
- Volume histogram: the y-axis number column was sized for 3-digit counts and let larger compact-formatted values ("1.5 M", "999.9 K") overflow past its left edge instead of fitting inside it.

### Changed

- Volume histogram legend narrowed (220px → 140px) to give the chart more width; truncated legend entries now show their full value in a tooltip on hover.

---

## [0.4.7] — 2026-08-04

### Fixed

- The field-stats sidebar popover built its WHERE clause without the discovered field index, unlike every other query in the app — a filter on a Map/JSON field could silently resolve differently there than in the grid/histogram, showing top-values for the wrong condition.

### Removed

- Dropped the unused Go backend scaffold (`pkg/`, Magefile, go.mod) — this plugin has always been frontend-only (`plugin.json` already declared `"backend": false`); the ping/echo resource handlers were never called by anything.

### Changed

- Internal cleanup pass: deduplicated repeated SQL-builder and query-cache logic, converted the last inline-styled modal to the shared theme pattern, fixed three pre-existing lint errors (`react-hooks/refs`, `react-hooks/set-state-in-effect`, `curly`), and split `LogsExplorer`/`VolumeHistogram`/`LogDetailDrawer` into smaller, independently-tested modules. No user-facing behavior change beyond the fix above.

---

## [0.4.6] — 2026-08-03

### Changed

- Filter pills in the Logs Explorer toolbar now match Kibana Discover's filter bar visually and functionally: click a pill to open a context menu (Edit filter, Exclude/Include results, Temporarily disable/Re-enable, Delete) instead of only being able to add or remove them. Editing reuses the existing Add-filter field/operator/value form, prefilled. Disabled pills are excluded from the query but kept in the pill list, URL, and saved searches.

---

## [0.4.5] — 2026-08-03

### Added

- Reverse half of the trace↔logs integration: a "View logs in ClickHouse Observe" button in Grafana Explore's ClickHouse trace view header, jumping back into Logs Explorer filtered to that trace, with the right data view and a time range spanning the trace (±5min) pre-selected. When a trace's datasource matches more than one configured data view, a picker lets you choose (optionally remembered per datasource); when none match, it offers all views as a fallback.

---

## [0.4.4] — 2026-08-03

### Changed

- The traceId in the log detail drawer no longer just adds an in-plugin "filter by trace" pill (redundant with the row's existing "Filter for value" action). It's now a link straight into Grafana Explore's ClickHouse trace waterfall, reusing the "View trace" link the ClickHouse datasource already generates for its own trace queries — no extra config needed beyond the datasource's own Traces defaults. Falls back to plain text when the datasource has no Traces config.

---

## [0.4.3] — 2026-08-02

### Fixed

- "Guess with AI" (and the manual column-mapping dropdowns next to it) couldn't see inside Tuple or JSON columns — a `trace Tuple(id String, span_id String)` column could only ever be offered/guessed as the whole `trace` struct, never `trace.id`. Guessing `trace` for Trace ID or `service` for Service Name then rendered the raw struct (e.g. `{"name": "my-service"}`) instead of the string. Tuple/JSON columns are now expanded into their dotted leaf fields (`trace.id`, `service.name`, JSON paths) before being offered, matching how the rest of the app already addresses them.

---

## [0.4.2] — 2026-08-02

### Fixed

- Histogram bars could render as empty when they actually held data, and the "N documents" count could be lower than a sub-range of the same view — caused by the volume query's execution guardrail silently truncating the aggregation (`timeout_overflow_mode = 'break'` + a rows-read cap) instead of erroring. Now throws on timeout so an over-budget query fails visibly rather than drawing a wrong chart.

---

## [0.4.1] — 2026-08-02

### Changed

- Removed the redundant "Copy link" toolbar button — the address bar already stays in sync with the full shareable view state, so it was copy-pasting the same thing the browser already shows.
- Moved "Saved" and "Add to dashboard" from the top toolbar row down to the Edit-as-SQL / Inspect-SQL row, right-aligned.
- Swapped the "Saved" button's icon from a save/disk icon to a search icon, so it reads as "saved searches" rather than "save this."

---

## [0.4.0] — 2026-08-02

### Removed

- Traces page (span waterfall, service map, trace list) and everything that only existed to serve it: `TraceExplorer`, `src/components/trace/`, `src/sql/trace/`, trace query builders, trace-only `ColumnMapping` fields (span ID/parent span ID/duration/span name/status code/status message/span kind/resource attributes), `SourceConfig.tracesTable`, and the corresponding capability flags.

### Changed

- The "View trace" button in the log detail drawer no longer navigates to the Traces page (which no longer exists) — it now filters the log list down to every log carrying that trace ID.

---

## [0.3.6] — 2026-07-14

### Added

- **Shareable Logs Explorer URLs.** Search, filters, columns, sort, time range, and active data
  view now encode into the URL as you work — copy the link (new "Copy link" button) and a
  colleague opens the identical view. Relative time ranges (`now-24h`) stay relative, not frozen
  to an absolute instant, matching Kibana/HyperDX convention. Columns are only encoded when
  actually customized (not the view's untouched defaults), keeping links short.
- **"Field has any value" filter button** in the field sidebar, alongside the existing
  filter-empty action — one click for `notEmpty(toString(field))`.
- **ClickHouse `Tuple`/`Nested`/`Array` column support.** Tuple columns (including nested
  tuple-in-a-tuple, flattened to dotted names like `a.x`) are now discovered as individual
  filterable/selectable fields, the same way Map keys and JSON paths already are — no extra query
  needed, parsed straight from the column's type string. `Nested(...)` and plain `Array(...)`
  columns are now typed correctly instead of falling through to `unknown`.

### Fixed

- **Log detail drawer was slow to open**, regressed by an earlier perf change that narrowed the
  list query but left the drawer re-running a whole-page `SELECT *` on every row click. Replaced
  with a single-row point lookup (millisecond-window + core-field match, `LIMIT 1`); the old
  whole-page fetch is kept only as a fallback for the rare timestamp-precision miss.
- **Logs Explorer ran its main queries twice on a cold load**, doubling the histogram's cost and
  chaining the second run behind field discovery finishing (~15s on large datasets). The queries
  no longer depend on the (async) field index directly; a guarded one-shot reconcile still re-runs
  them if a URL/saved-search filter references a not-yet-discovered field.
- **"Filter out" (and `contains`/multi-value filters) replaced an existing pill on the same field
  instead of appending.** Clicking "Filter out" on two different values for the same field used
  to silently drop the first — filters now only dedupe an exact re-add of the same field+op+value,
  so different values on the same field correctly stack as AND.
- **Log table header could visually overlap the first row** after adding a column — `position:
  sticky` on a `<th>` inside a `border-collapse: collapse` table is a known cross-browser
  fragility around reflow. Switched to `border-collapse: separate`.

### Changed

- **Toolbar condensed to one line** (Kibana Discover style): the search bar moved into the header
  row instead of its own line below, and the "Search" button shrank to icon-only (Enter still
  submits) — reclaims vertical space for the log table. Time range + refresh now wrap together as
  one unit on narrow viewports instead of separating.

---

## [0.3.5] — 2026-07-12

### Fixed

- **Log detail drawer didn't fill its pane width**, leaving dead space to the right that grew
  larger when the drawer was expanded — the panel's root element had no `width: 100%`, so it sat
  at its intrinsic content width instead of stretching to fill the splitter pane.
- **Top toolbar (Data view / filters / Saved / time range / refresh) could clip/overflow** at
  narrower viewport widths instead of wrapping to a second line.
- **Row expand/detail icon gave no feedback.** The button's hover style targeted a CSS class that
  was never actually applied (a typo'd selector), so hovering never highlighted it; the icon also
  never reflected whether that row's detail was open. It now highlights and swaps to a "collapse"
  glyph when the row's drawer is open.

### Changed

- **Fields sidebar auto-minimizes when the log detail drawer opens** (frees width for the drawer)
  and restores on close — unless it was already manually collapsed before opening.
- Sidebar collapse/expand icons switched to the double-chevron (`«`/`»`) style.
- Log detail drawer's field/value table now has zebra-striped rows.
- Minor container CSS hardening (`width: 100%` / `box-sizing: border-box`) to prevent similar
  width-collapse issues elsewhere in the Logs Explorer layout.

---

## [0.3.4] — 2026-07-11

### Added

- **Pinned columns.** A data view can now save a set of extra (non-core) columns that load with
  the grid by default — configured in the Create/Edit data view modal, reusing the same field
  discovery the sidebar already uses (including Map/JSON leaf paths). Core columns (Time/Level/
  Service/Message) stay fixed and non-removable, as before.

### Changed

- **Log detail drawer redesigned:** sans-serif field labels with a type icon per row, monospace
  values, airier rows with hairline separators, and a minimal header (severity + service +
  timestamp + nav, no redundant "Log detail" title).
- **Map attribute columns (Resource/Log/Scope Attributes) are now auto-detected**, the same way
  JSON columns already were — no config mapping required. The 3 corresponding fields in the Logs
  data-view editor are gone; the log detail drawer auto-flattens any discovered Map column, not
  just previously-configured ones.
- **KQL search no longer guesses a Map column for an unrecognized field name.** Typing a bare/
  dotted field that wasn't actually discovered (e.g. `http.method:GET` before/without discovery)
  used to silently wrap it in `LogAttributes['...']` and return nothing if wrong — it now resolves
  only via real field discovery or explicit `Col['key']` bracket syntax; an unresolved field
  surfaces a real ClickHouse error instead of a silent empty result.
- **Field-discovery scan queries (Map keys / JSON paths) are now execution-bounded**, matching
  HyperDX's own limits: `max_execution_time=15`, `max_rows_to_read=3000000`, graceful partial
  results on overflow instead of an unbounded scan. Discovery also caps concurrency at 4 scans in
  flight at once instead of firing one per column unbounded.

### Fixed

- **Severity histogram breakdown filter matched nothing.** The breakdown query used to lowercase
  severity server-side for display grouping (`lower(toString(...))`) but the filter-click action
  compared the real column against that lowercased value — `SeverityText = 'error'` never matches
  data stored as `'ERROR'`. Removed the lowercasing entirely — the histogram now displays, colors,
  and filters using the real stored casing throughout.
- **JSON fields couldn't be filtered from the log table at all.** A cell's raw value comes back as
  a parsed object for JSON fields, and the filter button was unconditionally hidden for any
  object-typed cell. Filtering now works for JSON leaf values (stringified the same way the cell
  already displays them); filtering a whole raw Map/JSON *container* column (e.g. the entire
  `ResourceAttributes` blob added directly, not a flattened leaf) is excluded on purpose — verified
  against ClickHouse directly that comparing a Map column to a stringified blob is a hard query
  error, not just a semantic no-op.

---

## [0.3.3] — 2026-07-09

### Fixed

- **Column add/remove/reorder redundantly re-ran the volume histogram query.** The logs and
  histogram queries were split into independent fetches so a column mutation only re-runs the
  grid query, not the histogram.
- **No loading cue on multi-query actions.** Rapid filter/sort/column mutations now debounce
  (~200ms) instead of firing a query burst; the volume histogram shows a dim overlay + spinner
  during a refetch instead of silently keeping stale bars.
- **Edit data view modal resized/flickered while loading columns.** The columns step now holds a
  stable min-height across the loading→loaded swap.
- **Wide tables (hundreds of columns) and large discovered field lists were slow to render.** The
  field sidebar's "Available" list is now virtualized; the per-row hover toolbar in the log table
  now mounts only for the hovered cell instead of every cell in every row.
- **JSON path discovery scanned each row's `JSONAllPathsWithTypes` twice.** Rewritten to evaluate
  it once per row, halving that query's per-row cost.
- **Map-typed fields displayed the same icon as JSON fields**, making a Map column read as JSON in
  the field sidebar. Map now has its own icon.
- **Severity breakdown in the histogram couldn't be filtered** — only field breakdowns could.
  Both bar-click and shift-click-legend filtering now work for severity too.
- **Inconsistent filter icons** across the table, histogram, field sidebar, and log detail —
  standardized on filter-plus/filter-minus everywhere.
- **Histogram tooltip capitalized severity labels** while the legend didn't. Both now match.
- **Only "Close" collapsed the log detail panel.** Clicking the already-open row now also
  collapses it; added an expand/shrink button on the panel header.
- **Non-attribute JSON columns showed as one raw stringified blob in the log detail table.** Any
  JSON-typed column now flattens into dotted-path rows, not just the four configured attribute
  containers.
- **Column-mapping fields were free-text with no column list**, and the Logs data-view editor
  showed trace-only fields (Span ID, Duration, etc.) that have no effect there. Fields are now
  searchable dropdowns sourced from the table's actual columns; trace-only fields are hidden in
  the Logs editor (Trace ID stays, since it powers the log→trace jump link).

---

## [0.3.2] — 2026-07-09

### Fixed

- **Sorting by a custom (non-core) column, then removing it, broke the query.** The column's
  sort key was a synthetic SELECT alias that no longer existed once the column was removed,
  producing an `ORDER BY` referencing an unknown identifier. Removing a column now clears sort
  if that column was the active sort target.
- **Adding the same field as a column from the log detail panel could create a duplicate
  column.** The detail panel built its own id/alias for a field instead of reusing the one the
  field sidebar uses, so the same field could end up selected twice under two different ids.
- Field sidebar could spin indefinitely if no datasource was ever configured (loading state
  never resolved).

---

## [0.3.1] — 2026-07-09

### Fixed

- **Filter pills looked flat and unclear.** Squared corners (was fully rounded), a thicker
  saturated polarity border with a matching tint instead of a flat gray chip, and negated
  exists/one-of filters now show a "NOT" prefix (e.g. "NOT field is one of [...]") — display-only,
  `filterLabel()`'s underlying text is unchanged.
- **Compare modal collapsed multi-line messages (e.g. stack traces) onto one line.** The value
  cell had no `white-space: pre-wrap`, so embedded line breaks were silently collapsed by the
  default `white-space: normal`.
- Compare button and Wrap-lines toggle had no gap between them, sitting flush against each other.

---

## [0.3.0] — 2026-07-09

### Added

- **Logs Explorer overhaul.** Resizable sidebar/table/detail panes, inline
  log detail panel (replaces the old overlay drawer), flat searchable field sidebar, zebra-striped
  rows with uniform 2-line message clamping, drag-to-reorder table columns, drag a field from the
  sidebar onto the table to add it as a column at the exact position dropped, click-to-filter
  histogram breakdown segments with a filter-for/filter-out popup, right-side histogram legend
  with isolate/toggle series clicks, auto-refresh via `RefreshPicker`, multi-row compare view,
  editable/searchable data views, and a wider add-filter popup.

### Fixed

- **Histogram's last time bucket always rendered empty.** `fillEmptyBuckets` looped `t <= end`,
  which added a spurious trailing bucket exactly at the range's end instant whenever the range
  span divided evenly by the bucket step (e.g. a round "last 1 hour") — that bucket's window only
  ever contained a single instant of query data, so it was structurally near-empty regardless of
  real events. Changed to `t < end`.
- **Infinite fetch loop when no breakdown choice was made yet.** The derived `breakdown` value
  fell back to a freshly-built object literal on every render, churning `executeQuery`'s identity
  and retriggering the effect that calls it.
- **Severity breakdown silently reset to "none" on every page load.** `FieldsContext`'s `loading`
  flag started `false` before field discovery had even begun, so the severity-fallback guard read
  "checked, no severity column" on the very first render and locked in "none" as a permanent
  explicit choice.
- **Log detail panel collapsed to a handful of raw columns after any auto-refresh, filter, or
  time-range change.** The list query's returned rows are new objects each time; the open detail
  panel's `selectedRow` kept pointing at the old, now-detached object. Re-points it at the
  matching row in the new results by content key (or closes the panel if that row no longer
  matches).
- Adding/removing a table column while defaults were still showing wiped out the whole default
  column set instead of appending/removing one.
- Histogram y-axis rendered a stray tick above the chart (dividing by a zero max produced `NaN%`
  positioning) when a bucket had no data.
- `mapKeys()` scans against Map-typed OTel attribute columns no longer run against columns that
  are actually `String`/`JSON` in the target schema (was throwing ClickHouse error 43).

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
- **Collapsible JSON tree in the log detail drawer.** The JSON tab now renders a per-node
  collapsible tree instead of a flat `JSON.stringify` dump.

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

- **Log detail drawer overhaul** — rebuilt as a document view: sticky
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

#### Histogram interval + breakdown controls

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
column (`theme.colors.action.hover`). The band tracks the cursor, is hidden during
drag-select, and clears on mouse leave.

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
- **Operator dropdown** — eight operators:
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
