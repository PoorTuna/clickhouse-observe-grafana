# Clickhouse-Observe

A Grafana App plugin for exploring logs and traces stored in ClickHouse.

## Requirements

- Grafana 10.0+
- [ClickHouse data source plugin](https://grafana.com/grafana/plugins/grafana-clickhouse-datasource/) configured and connected

## Features

### Logs Explorer

Browse and search log data from ClickHouse with a Kibana-style interface:

- **KQL search** — filter logs using Kibana Query Language (field:value, wildcards, ranges, boolean operators)
- **Field sidebar** — auto-discovered columns with top-value breakdown and one-click filtering
- **Volume histogram** — log count over time; click-and-drag to narrow the time range
- **Filter pills** — active filters shown as removable chips
- **Saved searches** — save and reload query state including filters, columns, and time range
- **Pagination** — configurable page size (10–500 rows), lazy-loads additional results on demand
- **Edit as SQL** — drop into raw SQL mode for ClickHouse-specific functions, regex, or complex expressions
- **Inspect SQL** — view the exact SQL query sent to ClickHouse without entering edit mode; copy to clipboard with one click

### Trace Explorer

Browse distributed traces stored in ClickHouse using the OpenTelemetry schema:

- Search by service name, trace ID, duration, and status
- Drill into individual traces to view span waterfall

## Getting Started

1. Install the plugin in Grafana
2. Go to **Configuration → ClickHouse Observe** and select your ClickHouse datasource
3. Map your table columns (timestamp, severity, body, service name, trace ID, etc.)
4. Open **Logs** or **Traces** from the navigation menu

## SQL Inspect

Click **▸ Inspect SQL** below the search bar to see the full SQL query that will be sent to ClickHouse. The panel shows a read-only, formatted SQL string with a **Copy** button. This is useful for:

- Debugging unexpected results
- Copying the query to run directly in ClickHouse Play or a SQL client
- Understanding how filters and column selections translate to SQL

When **Edit as SQL** mode is active, the Inspect SQL panel is hidden — the editable textarea is the authoritative query at that point.

## Contributing

Issues and pull requests welcome at the project repository.
