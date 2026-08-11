# ClickHouse Observe

HyperDX-style log explorer for ClickHouse, packaged as a Grafana app plugin.

![Logs Explorer](src/img/screenshot-logs.png)

---

## Requirements

- Grafana >= 10.0.0
- [ClickHouse datasource plugin](https://grafana.com/grafana/plugins/grafana-clickhouse-datasource/) installed and configured
- A ClickHouse table with log data (arbitrary schemas supported; OpenTelemetry schema works out of the box with the OTel preset)
- Node >= 22 (development only)

---

## Features

### Logs Explorer

A full-page log search view backed directly by ClickHouse SQL.

- **KQL search bar** — Kibana Query Language with autocomplete. Field names, operators, and top values are all suggested as you type, fetched live from ClickHouse.
- **Volume histogram** — log volume over time with configurable bucket interval (auto, second → month). Breakdown picker stacks bars by severity (when the column exists in the schema), any arbitrary field (top-10 + "Other" computed server-side), or shows a single series. Click and drag to zoom into a time range.
- **Field sidebar** — auto-discovered from `system.columns` plus Map-key introspection. Click a field to add it as a table column or filter. Per-field value distribution popover available on hover.
- **Sortable, reorderable columns** — add columns from the sidebar, remove them from the header, drag to reorder.
- **Row detail drawer** — click any row to see every column in the table (all fields, not just mapped ones). One-click "filter for" / "filter out" on any value. If the row carries a trace ID, a button filters the log list down to every log with that trace ID.
- **Structured filter builder** — `+ Add filter` button in the toolbar opens a Kibana-style popup: pick a field, choose an operator (`is`, `is not`, `is one of`, `is not one of`, `exists`, `does not exist`, `contains`, `does not contain`), and select a value from a live autocomplete dropdown. Supports multi-value lists and optional custom pill labels.
- **Filter pills** — active structured filters displayed as dismissable chips below the search bar. Supports all eight operators. Click × to remove; "Clear all" removes every pill at once.
- **Hybrid pagination** — initial 200-row buffer with lazy fetch as you page past it. Page size is configurable (10 – 500 rows per page).
- **Edit as SQL** — toggle to drop into raw ClickHouse SQL for full query control.
- **Saved searches** — save and restore any combination of KQL query, filters, columns, sort, and time range. Stored in browser localStorage.
- **Browser-local timestamps** — log timestamps are rendered in the browser's local timezone.

![Logs Explorer](src/img/screenshot-logs.png)

### Configuration

![Configuration](src/img/screenshot-config.png)

The configuration page is at **Administration > Plugins > ClickHouse Observe > Configuration**.

- Pick the ClickHouse datasource to query through.
- Set the database name and the logs table name.
- Map columns to their roles (timestamp, body, severity, trace ID, service name, attribute Map).
- **Apply OTel preset** fills in all column names for the standard OpenTelemetry Collector schema (`otel_logs`). Override individual fields below the preset button for custom schemas.

---

## KQL Search Reference

Follows [Kibana Query Language](https://www.elastic.co/docs/explore-analyze/query-filter/languages/kql) syntax and semantics — a query that's valid in Kibana should mean the same thing here.

| Syntax | Meaning |
|--------|---------|
| `level:error` | Field equals value (exact match) |
| `service:payment*` | Wildcard match |
| `service:*` | Field exists |
| `datastream.*:error` | Field-name wildcard — matches the value across every field the wildcard covers |
| `"payment failed"` | Phrase match on the log body (word-boundary, not a raw substring) |
| `active:true`, `deleted:false`, `parentId:null` | Typed literals — unquoted only; `field:"true"` stays the string `"true"` |
| `responseTime > 500` | Numeric greater-than |
| `responseTime >= 500` | Numeric greater-than-or-equal |
| `responseTime < 100` | Numeric less-than |
| `responseTime <= 100` | Numeric less-than-or-equal |
| `level:error and service:checkout` | Boolean AND |
| `level:warn or level:error` | Boolean OR |
| `not level:debug` | Boolean NOT |
| `level:error and service:pay* and latency > 1000` | Combined |

Bare terms without a field (`payment failed`) search the log body as one value — spaces don't split it into separate terms. **`and`/`or`/`not` must be written explicitly**: `level:error service:checkout` (no `and`) is a syntax error, same as Kibana, and the search bar refuses to run it rather than guessing. `?` is an ordinary character, not a wildcard — only `*` is. There's no regex support (Kibana doesn't have one either); for that, switch to raw SQL. Autocomplete suggests field names, operators, and live top values at each position.

---

## Configuration Steps

1. Install and configure the [ClickHouse datasource plugin](https://grafana.com/grafana/plugins/grafana-clickhouse-datasource/) with your ClickHouse connection details. Credentials live on the datasource, not on this app.
2. Build and copy (or run in dev mode — see below) this plugin so Grafana loads it.
3. In Grafana, go to **Administration > Plugins**, find **ClickHouse Observe**, and click **Enable**.
4. Open **Administration > Plugins > ClickHouse Observe > Configuration**.
5. Select the ClickHouse datasource from the dropdown.
6. Enter the database name (default: `default`) and logs table.
7. Click **Apply OTel preset** if your table follows the OpenTelemetry Collector schema. Otherwise fill in the column mapping fields manually.
8. Click **Save configuration**. The page reloads to apply the new settings.
9. Navigate to **More apps > ClickHouse Observe > Logs** to start querying.

---

## Development

```bash
# Install dependencies
npm install

# Build in development mode (watch)
npm run dev

# Build for production
npm run build

# Run unit tests (KQL parser, suggest, SQL generation)
npm run test:ci

# Check types
npm run typecheck

# Lint
npm run lint

# Start a local Grafana instance via Docker (plugin hot-reloads)
npm run server

# Run end-to-end tests (requires npm run server to be running)
npm run e2e
```

The Docker dev environment (`npm run server`) runs Grafana with unsigned plugin loading enabled and mounts the built `dist/` directory into the container. No signing is required for local development.

---

## Project Layout

| Path | Contents |
|------|----------|
| `src/pages/` | Top-level page components: `LogsExplorer.tsx` |
| `src/components/` | Shared UI: `SearchBar`, `LogsTable`, `LogDetailDrawer`, `VolumeHistogram`, `FilterPills`, `PaginationBar` |
| `src/components/AddFilter/` | Structured filter builder popup (`AddFilterPopover`) |
| `src/components/FieldSidebar/` | Field discovery sidebar, per-field stats popover |
| `src/components/AppConfig/` | Plugin configuration page |
| `src/sql/` | SQL generation: `queryBuilder.ts`, `filters.ts`, `fields.ts`, `introspection.ts` |
| `src/sql/kql/` | KQL engine: lexer, parser, AST, SQL emitter, autocomplete suggestions, value loader |
| `src/data/` | Data layer: `runQuery.ts` (Grafana datasource proxy), `savedSearches.ts` (localStorage) |

---

## Signing and Distribution

Plugins must be signed before they can be distributed via the Grafana plugin catalog or used in environments with signature enforcement. See the [Grafana plugin signing documentation](https://grafana.com/developers/plugin-tools/publish-a-plugin/sign-a-plugin) for instructions. The `npm run sign` script wraps `@grafana/sign-plugin` and requires a `GRAFANA_API_KEY` environment variable from a Grafana Cloud account whose slug matches the plugin ID prefix (`poortuna`).

---

**License:** Apache-2.0
