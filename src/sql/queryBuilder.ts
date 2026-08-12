/**
 * ClickHouse SQL generation for logs and volume queries.
 * Adapted from grafana/clickhouse-datasource src/data/sqlGenerator.ts (Apache-2.0).
 *
 * Uses $__fromTime / $__toTime macros — the CH datasource backend expands these
 * from the query request's time range automatically.
 */

import { BreakdownSel, ColumnMapping, FilterPill, FilterOp, LogsQueryState, SourceConfig } from '../types';
import { resolveField, FieldIndex } from './fields';
import { parseKql, kqlToSql } from './kql';
import { configSettingsFragments, withSettings } from './settings';

/**
 * Row-object keys for buildLogsQuery's core (fixed-role) columns. `__`-prefixed so they can't
 * collide with an arbitrary table's own real column of the same plain name — see buildLogsQuery.
 * Consumers (LogsTable, LogDetailDrawer, defaultColumns()) import this instead of hardcoding the
 * literal strings so the two sides can't drift.
 */
export const CORE_ALIAS = {
  timestamp: '__timestamp',
  body: '__body',
  severity: '__severity',
  traceId: '__traceId',
  serviceName: '__serviceName',
} as const;

/**
 * Content key for matching a narrow ('grid' projection) row to its later-hydrated ('full'
 * projection) counterpart — used by LogsExplorer to attach full-row data (Map attribute columns,
 * "All fields", JSON) to the detail drawer without depending on row offset/order, which
 * ClickHouse doesn't guarantee to be stable across two separate queries when sort keys tie.
 *
 * Grid rows always carry the `__`-aliased core values (buildLogsQuery's grid projection still
 * emits them). Full/detail rows no longer do — they're a bare `SELECT *`, so the same value is
 * only reachable under its real mapped column name (see H2 in the audit plan: aliasing an already-
 * selected column a second time just to have a fixed key name was pure duplicate cost). `config`
 * (optional — omit it for tests/callers that only ever compare same-shaped rows) lets this read
 * either shape and land on the same key either way: `row[CORE_ALIAS.timestamp] ?? row[config
 * .columns.timestamp]` finds the value whichever query produced the row.
 */
export function logRowKey(row: Record<string, unknown>, config?: SourceConfig): string {
  const c = config?.columns;
  const read = (alias: string, raw: string | undefined) =>
    row[alias] ?? (raw !== undefined ? row[raw] : undefined) ?? null;
  return JSON.stringify([
    read(CORE_ALIAS.timestamp, c?.timestamp),
    read(CORE_ALIAS.body, c?.body),
    read(CORE_ALIAS.severity, c?.severity),
    read(CORE_ALIAS.serviceName, c?.serviceName),
  ]);
}

const BARE_IDENT = '[A-Za-z_][A-Za-z0-9_]*';
/** A double-quoted SQL identifier using this file's own quoteIdentifier()/quoteDottedPath()
 *  escaping convention (embedded `"` doubled) — matches a single dotted-path segment quoteDottedPath
 *  produces for a segment that isn't bare-safe (e.g. a JSON path like `user-id`). */
const QUOTED_IDENT = '"(?:[^"]|"")*"';
const IDENT = `(?:${BARE_IDENT}|${QUOTED_IDENT})`;
/** A single-quoted SQL string literal using this file's own quoteString() escaping convention
 *  (backslash escaped first, then embedded single quotes) — matches what quoteString() actually
 *  produces, so this only recognizes a literal that really is safely escaped, not just "has quotes
 *  around it somewhere". */
const SAFE_STRING_LITERAL = `'(?:[^'\\\\]|\\\\.)*'`;

const MAP_ACCESSOR_RE = new RegExp(`^${IDENT}\\[${SAFE_STRING_LITERAL}\\]$`);
const DOTTED_PATH_RE = new RegExp(`^${IDENT}(\\.${IDENT})+$`);

/**
 * Recognizes a `name` that is a well-formed Map accessor (`Col['key']`, with a properly escaped
 * key) — nothing else. Deliberately narrower than `looksLikeTrustedExpr()` below: this is what
 * `resolveField()` (fields.ts) uses for its own "already an expression, pass through" branch, and
 * that branch must NOT also recognize a bare dotted chain like `user.id` — without field discovery
 * confirming such a name is a real JSON/Tuple path, treating it as one is exactly the "blind
 * guessing" this codebase's field resolution deliberately avoids (see resolveField's own doc
 * comment). A discovered JSON/Tuple path still reaches SQL emission correctly: it's returned
 * *before* this branch, via the `index.bySqlExpr`/`index.byName` lookups at the top of
 * `resolveField()`, so the narrower check here never needs to cover that case.
 */
export function looksLikeMapAccessor(name: string): boolean {
  return MAP_ACCESSOR_RE.test(name);
}

/**
 * Recognizes a `name` that is already a well-formed, self-contained SQL expression this codebase
 * itself constructed — a Map accessor (see `looksLikeMapAccessor`) or a dotted identifier chain
 * (`Payload.user.id` / `Payload."user-id"`, every segment either a bare identifier or a properly
 * quoted one, matching what `quoteDottedPath()` produces). Anything else — including a string that
 * merely *contains* `(`/`[`/`.` — is untrusted and must be quoted, never passed through.
 *
 * Used by `quoteIdentifier()`, which sees both trusted `resolved.sqlExpr` values (including
 * genuine discovered JSON/Tuple dotted paths — this is where those need to be recognized) *and*
 * raw untrusted fallback text when field resolution failed. The dotted-path branch is safe to
 * apply even to untrusted text: its character class is limited to identifier characters, dots, and
 * balanced quoting, which cannot express `OR 1=1`-style injection — unlike the old loose
 * `includes('(')` check this replaces (see C1 in the audit plan), which trusted *any* string
 * containing a paren, unquoted, straight into the WHERE clause.
 */
export function looksLikeTrustedExpr(name: string): boolean {
  return MAP_ACCESSOR_RE.test(name) || DOTTED_PATH_RE.test(name);
}

export function quoteIdentifier(name: string): string {
  if (looksLikeTrustedExpr(name)) {
    return name;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Builds a safe dotted-path SQL expression (`root.seg1.seg2…`) from field-discovery *data* — a
 * JSON path or Tuple element name reported back by ClickHouse, not something this codebase
 * controls the shape of. A discovered segment that isn't already a bare-safe identifier (e.g.
 * `user-id`, `k8s.io/name`, a segment starting with a digit) is double-quoted, same escaping
 * quoteIdentifier() already uses for its own safe branch — so callers get one consistent
 * identifier-quoting convention instead of two. `root` gets the same treatment: it's normally a
 * real column name from system.columns, lower risk than a data-driven path segment, but not zero
 * risk, so it isn't exempted.
 *
 * Deliberately does not attempt to disambiguate a `.` that is legitimately *part of* one segment's
 * name from the `.` ClickHouse itself uses as the path separator in the dotted notation it reports
 * — that's an inherent ambiguity of dot-notation paths, not something a quoting fix can resolve.
 */
export function quoteDottedPath(root: string, path: string): string {
  const quoteSegment = (seg: string) =>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(seg) ? seg : `"${seg.replace(/"/g, '""')}"`;
  return [root, ...path.split('.')].map(quoteSegment).join('.');
}

/**
 * Escape ILIKE metacharacters in a literal value so user input matches exactly.
 * Must be called BEFORE any wildcard-sentinel substitution — a real ILIKE wildcard is added only
 * after this has already neutralized any %/_ that came from the user's literal text.
 *
 * The resulting string is then passed to quoteString(), which doubles backslashes, so the SQL
 * value `\%` (escaped percent) is reached via:
 *   escapeLike('%') → '\%' (JS: backslash + percent)
 *   quoteString('\%') → SQL '\\%'    ← ClickHouse reads \\ as \, so pattern is \%
 *   ClickHouse ILIKE \% → literal %
 *
 * Shared by the KQL path (kql/toSql.ts) and the legacy free-text fallback below — both build
 * ILIKE patterns from user-typed text and need the same escaping, or %/_ act as wildcards in one
 * path but not the other.
 */
export function escapeLike(value: string): string {
  return value
    .replace(/\\/g, '\\\\')  // escape backslash first (must be first!)
    .replace(/%/g, '\\%')    // literal % → not an ILIKE wildcard
    .replace(/_/g, '\\_');   // literal _ → not an ILIKE single-char wildcard
}

export function tableRef(config: SourceConfig, table: string): string {
  return `"${config.database}"."${table}"`;
}

/**
 * Core aliases for mapped columns only, omitted entirely when unmapped. Aliased under a
 * `__`-prefixed name (CORE_ALIAS.*) rather than the field's plain name — an arbitrary table's own
 * real column can legitimately be named `timestamp`/`body`/`severity`/etc (unrelated to what the
 * user mapped to that role); a `__`-prefixed alias can't collide with a pre-existing column the
 * way a bare name can, closing off the whole collision class rather than special-casing individual
 * instances of it. Note: ResourceAttributes/LogAttributes/ScopeAttributes are deliberately NOT
 * aliased here — groupAttributes() (schema.ts) already reads them by their raw mapped column name
 * via SELECT *, so a fixed alias was dead weight.
 *
 * Grid-projection only. A `SELECT *` projection (buildLogsQuery's 'full', buildLogDetailQuery)
 * already returns each mapped column under its own real name — aliasing it again would just select
 * it a second time (see H2 in the audit plan) — so those callers no longer use this. Grid has no
 * `*` to fall back on, so it's the one projection that still needs a fixed, collision-proof name
 * here; logRowKey() bridges the two shapes by also checking the raw name when the alias is absent.
 */
function buildCoreSelectAliases(c: ColumnMapping): string[] {
  return [
    c.timestamp ? `${c.timestamp} AS ${CORE_ALIAS.timestamp}` : null,
    c.body ? `${c.body} AS ${CORE_ALIAS.body}` : null,
    c.severity ? `${c.severity} AS ${CORE_ALIAS.severity}` : null,
    c.traceId ? `${c.traceId} AS ${CORE_ALIAS.traceId}` : null,
    c.serviceName ? `${c.serviceName} AS ${CORE_ALIAS.serviceName}` : null,
  ].filter(Boolean) as string[];
}

function filterOpToSql(op: FilterOp): string {
  switch (op) {
    case '=':
      return '=';
    case '!=':
      return '!=';
    case 'contains':
      return 'ILIKE';
    case 'not_contains':
      return 'NOT ILIKE';
    case 'one_of':
      return 'IN';
    case 'not_one_of':
      return 'NOT IN';
    case 'exists':
    case 'not_exists':
      return ''; // handled separately below
  }
}

function buildFilterClause(filter: FilterPill, config: SourceConfig, index?: FieldIndex): string {
  const value = filter.value.trim();
  const resolved = resolveField(filter.field, config, index);
  const sqlExprRaw = resolved ? resolved.sqlExpr : filter.field;

  // exists / not_exists — value is irrelevant. quoteIdentifier() here is load-bearing, not
  // cosmetic: unlike every other branch below, this one used to interpolate sqlExprRaw directly
  // with no quoting at all, so a hostile filter.field reached raw SQL regardless of the
  // looksLikeTrustedExpr() fix elsewhere in this file (see C1 in the audit plan).
  if (filter.op === 'exists') {
    return `notEmpty(toString(${quoteIdentifier(sqlExprRaw)}))`;
  }
  if (filter.op === 'not_exists') {
    return `empty(toString(${quoteIdentifier(sqlExprRaw)}))`;
  }

  // one_of / not_one_of — use IN (...) / NOT IN (...)
  if (filter.op === 'one_of' || filter.op === 'not_one_of') {
    const vals = filter.values?.length ? filter.values : value ? [value] : [];
    if (vals.length === 0) {
      // guard: empty value set → always false / always true
      return filter.op === 'one_of' ? '1=0' : '1=1';
    }
    const col = quoteIdentifier(sqlExprRaw);
    const list = vals.map(quoteString).join(', ');
    return filter.op === 'one_of'
      ? `${col} IN (${list})`
      : `${col} NOT IN (${list})`;
  }

  // Standard single-value ops: =, !=, contains, not_contains
  const negate = filter.op === '!=' || filter.op === 'not_contains';

  if (resolved === null) {
    // Unknown field: treat the field name as a direct column, same as the KQL path.
    // Avoids emitting `undefined ILIKE …` when body is unmapped.
    const col = quoteIdentifier(sqlExprRaw);
    const op = filterOpToSql(filter.op);
    if (op === 'ILIKE' || op === 'NOT ILIKE') {
      return `${col} ${op} ${quoteString('%' + value + '%')}`;
    }
    return `${col} ${op} ${quoteString(value)}`;
  }

  const { sqlExpr, kind } = resolved;

  if (kind === 'text') {
    return negate
      ? `${sqlExpr} NOT ILIKE ${quoteString('%' + value + '%')}`
      : `${sqlExpr} ILIKE ${quoteString('%' + value + '%')}`;
  }

  const col = quoteIdentifier(sqlExpr);
  const op = filterOpToSql(filter.op);
  if (op === 'ILIKE' || op === 'NOT ILIKE') {
    return `${col} ${op} ${quoteString('%' + value + '%')}`;
  }
  return `${col} ${op} ${quoteString(value)}`;
}

/**
 * Build the WHERE fragment for a search string, parsing it as KQL first.
 *
 * The live search bar (SearchBar.commit()) rejects an unparseable query before it ever reaches
 * here — same as Kibana, which never sends a query it couldn't parse client-side. The try/catch
 * below is a safety net for callers that don't go through that gate and can't afford to throw
 * mid-render: a restored saved search, a URL-shared query, or dashboard-panel export, any of which
 * may hold a query written before a syntax change like this one. Those fall back to a legacy
 * free-text body search rather than breaking the page.
 */
export function buildSearchClause(search: string, config: SourceConfig, index?: FieldIndex): string {
  const term = search.trim();
  if (!term) {
    return '';
  }

  // Try to parse as KQL first.
  try {
    const ast = parseKql(term);
    return kqlToSql(ast, config, index);
  } catch {
    // Fall back to legacy free-text body search on any parse error so existing
    // queries and partial input never break a live result set.
  }

  // Legacy fallback: tokenize and ILIKE on body.
  const c = config.columns;
  // No body column mapped → can't do free-text search; skip rather than emit ILIKE(undefined,…).
  if (!c.body) {
    return '';
  }
  const terms = term.match(/"[^"]*"|'[^']*'|\S+/g) ?? [term];
  const clauses = terms.map((t) => {
    const clean = t.replace(/^["']|["']$/g, '');
    // escapeLike so a literal % or _ in the raw text can't act as an ILIKE wildcard here — the
    // KQL path (kql/toSql.ts's bareTermSql) already escapes it; this legacy fallback used to not.
    // No hasToken() here — it throws BAD_ARGUMENTS on any needle containing a separator character
    // (`-`, `.`, `:`, `/`, space — all common in log search terms like "req-59" or "1.2.3.4"), and
    // is redundant even when it doesn't throw: everything a case-sensitive whole-token hasToken()
    // match can find, the case-insensitive substring ILIKE below already finds too. See C3 in the
    // audit plan.
    return `${c.body} ILIKE ${quoteString('%' + escapeLike(clean) + '%')}`;
  });
  return clauses.length === 1 ? clauses[0] : clauses.map((cl) => `(${cl})`).join(' AND ');
}

/** Build the WHERE conditions shared across logs, volume, and field-stats queries. */
export function buildWhereConditions(config: SourceConfig, state: LogsQueryState, index?: FieldIndex): string[] {
  const conditions: string[] = [];
  // Only add the time filter when a timestamp column is mapped (no-time views skip this).
  if (config.columns.timestamp) {
    conditions.push(
      `${config.columns.timestamp} >= $__fromTime AND ${config.columns.timestamp} <= $__toTime`
    );
  }
  if (state.search.trim()) {
    conditions.push(buildSearchClause(state.search, config, index));
  }
  for (const f of state.filters) {
    if (f.disabled) {
      continue;
    }
    conditions.push(buildFilterClause(f, config, index));
  }
  return conditions;
}

export interface BuildLogsQueryOpts {
  /**
   * 'full' (default): bare SELECT * — every real column, needed by the log detail drawer
   * (Resource/Log/Scope/Span Attributes, "All fields", JSON tab all read the raw row). No core
   * aliasing here: `*` already includes each mapped column under its own real name, so aliasing
   * Timestamp/Body/etc a second time (the old behavior) just sent them twice — see H2 in the audit
   * plan. 'grid': omit the `*` — only the core aliases + extra columns the results grid actually
   * renders (still aliased, since this is the one projection that has no `*` to fall back on).
   * Callers that don't pass this get the historical SELECT * behavior unchanged.
   */
  projection?: 'grid' | 'full';
}

/** Maps a CORE_ALIAS name back to the real column it was standing in for, so a sort column chosen
 *  against the grid projection (which is always aliased) still resolves against a non-grid
 *  projection (bare SELECT *, no aliases) — see buildLogsQuery's sortCol handling below. */
function coreAliasToRawColumn(alias: string, c: ColumnMapping): string | undefined {
  switch (alias) {
    case CORE_ALIAS.timestamp: return c.timestamp;
    case CORE_ALIAS.body: return c.body;
    case CORE_ALIAS.severity: return c.severity;
    case CORE_ALIAS.serviceName: return c.serviceName;
    case CORE_ALIAS.traceId: return c.traceId;
    default: return undefined;
  }
}

export function buildLogsQuery(
  config: SourceConfig,
  state: LogsQueryState,
  pagination?: { limit: number; offset: number },
  opts?: BuildLogsQueryOpts,
  index?: FieldIndex
): string {
  const c = config.columns;
  const tbl = tableRef(config, config.logsTable);
  const isGrid = opts?.projection === 'grid';

  // Extra SELECT for user-added non-core columns — kept in every projection, including the bare
  // SELECT * one: a user-added column's sqlExpr can be an arbitrary expression (a Map accessor, a
  // JSON path, a function call), not necessarily a real column `*` would already cover.
  const extraSelect = (state.columns ?? [])
    .filter((col) => !col.isCore)
    .map((col) => `${col.sqlExpr} AS ${col.key}`);

  // Grid projection has no `*` to fall back on, so it still needs the core columns aliased
  // in — that's the one thing this projection's own SELECT list has to provide. Grid projection
  // only ever omits `*` when there's at least one aliased/extra column to take its place — an
  // arbitrary table with nothing mapped and no user-added columns would otherwise produce an
  // empty (invalid) SELECT list, so fall back to `*` in that case.
  const coreSelect = isGrid ? buildCoreSelectAliases(c) : [];
  const gridSelect = [...coreSelect, ...extraSelect];
  const selectParts = isGrid && gridSelect.length > 0 ? gridSelect : ['*', ...extraSelect];
  const conditions = buildWhereConditions(config, state, index);

  let sortCol = state.sort?.col ?? (c.timestamp ? CORE_ALIAS.timestamp : null);
  if (sortCol && !isGrid) {
    // A sort column carried over from the grid (either the default above, or a value the user
    // picked by clicking a grid column header — those are always CORE_ALIAS names, since that's
    // what the grid's own SELECT list exposes) has nothing to resolve against in a bare SELECT *
    // query, which emits no such alias. Translate it back to the real column name `*` already
    // provides. Anything else — an extraSelect column's own key, or an already-raw name — passes
    // through unchanged; extraSelect's aliases are still emitted in every projection.
    sortCol = coreAliasToRawColumn(sortCol, c) ?? sortCol;
  }
  const sortDir = (state.sort?.dir ?? 'desc').toUpperCase();

  return withSettings(
    [
      `SELECT ${selectParts.join(', ')}`,
      `FROM ${tbl}`,
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : null,
      sortCol ? `ORDER BY ${sortCol} ${sortDir}` : null,
      pagination
        ? `LIMIT ${pagination.limit} OFFSET ${pagination.offset}`
        : `LIMIT ${state.limit}`,
    ],
    configSettingsFragments(config)
  );
}

/**
 * Execution guardrail for buildLogDetailQuery — a narrow point lookup should be near-instant.
 *
 * Previously used `max_rows_to_read` + `read_overflow_mode = 'break'` on the theory that the 1ms
 * WHERE window (see buildLogDetailQuery's doc comment) never has enough rows in scope for a
 * rows-read cap to bite. That's only true if the timestamp column is a prefix of the table's
 * ORDER BY — on a table sorted by e.g. (ServiceName, Timestamp) the 1ms window can't be
 * index-pruned, the scan can hit the rows cap, and 'break' silently returned 0 rows: a real match
 * indistinguishable from "not found," which is exactly the "1 row, then 0 rows on the same click"
 * bug this file exists to fix. `throw` on timeout instead — the caller (hydrateRow in
 * LogsExplorer.tsx) already has a real error path via its catch block, and a loud failure beats a
 * quietly wrong "not found."
 */
const DETAIL_QUERY_SETTINGS = [`max_execution_time = 10`, `timeout_overflow_mode = 'throw'`];

/**
 * Best-effort coercion of a log row's timestamp cell (DateTime-like object, epoch-ms number, or
 * a raw ClickHouse DateTime64 string such as "2026-06-29 06:00:00.123456789") to epoch
 * milliseconds. Mirrors formatTimestamp's (components/LogsTable.tsx) branching, but self-
 * contained here since queryBuilder.ts has no dependency on @grafana/data's time helpers.
 * Deliberately lossy below millisecond precision — buildLogDetailQuery only needs a millisecond-
 * wide WHERE window, not an exact instant (see its doc comment for why exact equality is unsafe).
 */
function coerceEpochMs(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'object' && 'valueOf' in (value as object)) {
    const v = (value as { valueOf(): unknown }).valueOf();
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  const str = String(value).trim();
  const match = str.match(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})(\.\d+)?/);
  if (!match) {
    return null;
  }
  const fracMs = match[2] ? Math.round(Number(`0${match[2].slice(0, 4)}`) * 1000) : 0;
  const baseMs = Date.parse(`${match[1].replace(' ', 'T')}Z`);
  return Number.isFinite(baseMs) ? baseMs + fracMs : null;
}

/**
 * Fetches just the single row the log detail drawer was opened for, instead of hydratePage's
 * whole-page `SELECT *` (see hydratePage's doc comment in LogsExplorer.tsx for the cost that
 * replaces). WHERE narrows to a one-millisecond window around the clicked row's timestamp rather
 * than an exact-equality match — the client only ever has the timestamp at millisecond precision
 * or as a string it can't losslessly round-trip against a DateTime64(9) column, so an exact match
 * can miss the very row it's looking for. Combined with equality on whichever other core fields
 * are mapped (body/severity/serviceName) — the same fields logRowKey() already uses to treat two
 * rows as identical throughout this codebase — a match found this way is exactly as "correct" as
 * what hydratePage's whole-page fetch would have matched by content key. Returns '' (no query) if
 * no timestamp is mapped or the row's timestamp can't be parsed — caller falls back to hydratePage.
 *
 * Bare `SELECT *` — no core aliasing. `*` already returns each mapped column under its own real
 * name, so the fetched row still produces the same logRowKey() as the grid row it's replacing in
 * `hydratedRows`, as long as logRowKey() is given `config` to read those raw names by (see H2 in
 * the audit plan and logRowKey's own doc comment).
 */
export function buildLogDetailQuery(
  config: SourceConfig,
  row: Record<string, unknown>,
  index?: FieldIndex
): string {
  const c = config.columns;
  if (!c.timestamp) {
    return '';
  }
  const tsMs = coerceEpochMs(row[CORE_ALIAS.timestamp]);
  if (tsMs === null) {
    return '';
  }
  const tbl = tableRef(config, config.logsTable);

  const conditions = [
    `${c.timestamp} >= fromUnixTimestamp64Milli(${tsMs})`,
    `${c.timestamp} < fromUnixTimestamp64Milli(${tsMs + 1})`,
  ];
  if (c.body && row[CORE_ALIAS.body] !== undefined) {
    conditions.push(`${c.body} = ${quoteString(String(row[CORE_ALIAS.body] ?? ''))}`);
  }
  if (c.severity && row[CORE_ALIAS.severity] !== undefined) {
    conditions.push(`${c.severity} = ${quoteString(String(row[CORE_ALIAS.severity] ?? ''))}`);
  }
  if (c.serviceName && row[CORE_ALIAS.serviceName] !== undefined) {
    conditions.push(`${c.serviceName} = ${quoteString(String(row[CORE_ALIAS.serviceName] ?? ''))}`);
  }
  // index is accepted (not used) to keep this builder's signature interchangeable with
  // buildLogsQuery at call sites — point-match conditions above are raw core columns, never
  // Map-key/JSON-path field references that would need index resolution.
  void index;

  return withSettings(
    [
      `SELECT *`,
      `FROM ${tbl}`,
      `WHERE ${conditions.join(' AND ')}`,
      `LIMIT 1`,
    ],
    [...DETAIL_QUERY_SETTINGS, ...configSettingsFragments(config)]
  );
}

export type CHIntervalUnit = 'SECOND' | 'MINUTE' | 'HOUR' | 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';

export type VolumeBreakdown =
  /** One bar per bucket, no per-series coloring. */
  | { kind: 'none' }
  /** Stack by severity column — no CTE, same as the original query. */
  | { kind: 'severity'; expr: string }
  /** Top-N breakdown by a chosen field expression + 'Other' catch-all via CTE. */
  | { kind: 'field'; expr: string; limit?: number };

/**
 * Execution guardrail for the volume/histogram query — unlike the grid query (bounded by a
 * `LIMIT` on the ordering key) and field discovery (see introspection.ts's DISCOVERY_SETTINGS),
 * buildVolumeQuery's GROUP BY has no LIMIT and scans the full time range, so on a large dataset
 * it's the single most expensive query this page fires on every mount.
 *
 * Deliberately no `max_rows_to_read` / `read_overflow_mode = 'break'` here, unlike the other
 * guardrails in this file — counting rows is this query's entire job, so a rows-read cap doesn't
 * bound cost, it just truncates the count. Which granules get read before the cap fires follows
 * part/primary-key order across parallel reading threads, not chronological order, so 'break'
 * silently zeroes out whole time buckets rather than shaving a bit off every bucket. Those zeroed
 * buckets are then indistinguishable from genuine no-data gaps once fillEmptyBuckets
 * (VolumeHistogram.tsx) runs, so the chart (and the summed document count above it) reports a
 * confidently wrong answer instead of a visibly incomplete one — worse than the hung request this
 * was meant to avoid. `throw` on timeout instead: a real error the user can act on (narrow the
 * range, pick a coarser interval) beats a histogram that lies.
 */
const VOLUME_QUERY_SETTINGS = [`max_execution_time = 60`, `timeout_overflow_mode = 'throw'`];

export interface VolumeQueryOpts {
  /**
   * Fixed bucket width, or `{ macro: true }` to defer bucketing to the CH datasource's
   * `$__timeInterval(...)` macro — used when exporting to a dashboard panel so the bucket
   * width adapts to whatever time range the dashboard is showing, not the range at export time.
   */
  interval: { unit: CHIntervalUnit; value: number } | { macro: true };
  breakdown: VolumeBreakdown;
}

export function buildVolumeQuery(
  config: SourceConfig,
  state: LogsQueryState,
  opts: VolumeQueryOpts,
  index?: FieldIndex
): string {
  const c = config.columns;
  // Bucketing by time is the entire point of a volume query — meaningless without a mapped
  // timestamp column. Callers already gate execution on caps.hasTime, but the builder itself
  // shouldn't rely on every caller remembering that (panelExport.ts is a second such caller).
  if (!c.timestamp) {
    return '';
  }
  const tbl = tableRef(config, config.logsTable);
  const { interval, breakdown } = opts;
  const timeExpr = 'macro' in interval
    ? `$__timeInterval(${c.timestamp})`
    : `toStartOfInterval(${c.timestamp}, INTERVAL ${interval.value} ${interval.unit})`;
  const conditions = buildWhereConditions(config, state, index);
  const condSql = conditions.join(' AND ');

  const whereSql = condSql ? `WHERE ${condSql}` : '';

  if (breakdown.kind === 'none') {
    // Single series: constant empty-string level so the fold loop stays generic.
    return withSettings(
      [
        `SELECT ${timeExpr} AS time, '' AS level, count() AS count`,
        `FROM ${tbl}`,
        whereSql || null,
        `GROUP BY time, level`,
        `ORDER BY time ASC`,
      ],
      [...VOLUME_QUERY_SETTINGS, ...configSettingsFragments(config)]
    );
  }

  if (breakdown.kind === 'severity') {
    // Stack by severity column — no CTE, identical to the original behaviour.
    // No case normalization: 'INFO' and 'info' are genuinely separate values unless the data
    // itself normalizes them — silently lower()-ing here just meant the value shown, colored, and
    // filterable was never what was actually in the column, which is its own bug (filter clicks
    // on a breakdown segment produced `SeverityText = 'error'` against data stored as 'ERROR',
    // matching nothing). If a table's severity values are genuinely inconsistently cased, that's
    // real data to show as real data, not something to paper over here.
    return withSettings(
      [
        `SELECT ${timeExpr} AS time, toString(${breakdown.expr}) AS level, count() AS count`,
        `FROM ${tbl}`,
        whereSql || null,
        `GROUP BY time, level`,
        `ORDER BY time ASC`,
      ],
      [...VOLUME_QUERY_SETTINGS, ...configSettingsFragments(config)]
    );
  }

  // Field breakdown: compute top-N server-side so 'Other' is one aggregated series.
  const limit = breakdown.limit ?? 10;
  const exprStr = `toString(${breakdown.expr})`;
  return withSettings(
    [
      `WITH top AS (`,
      `  SELECT ${exprStr} AS v`,
      `  FROM ${tbl}`,
      whereSql ? `  ${whereSql}` : null,
      `  GROUP BY v ORDER BY count() DESC LIMIT ${limit}`,
      `)`,
      `SELECT ${timeExpr} AS time,`,
      `       if(${exprStr} GLOBAL IN (SELECT v FROM top), ${exprStr}, 'Other') AS level,`,
      `       count() AS count`,
      `FROM ${tbl}`,
      whereSql || null,
      `GROUP BY time, level`,
      `ORDER BY time ASC`,
    ],
    [...VOLUME_QUERY_SETTINGS, ...configSettingsFragments(config)]
  );
}

/**
 * Map the UI-level breakdown selection to the SQL-level VolumeBreakdown.
 * Shared by the live histogram query (LogsExplorer) and dashboard-panel export so the two
 * never drift apart.
 */
export function resolveVolumeBreakdown(breakdown: BreakdownSel, config: SourceConfig): VolumeBreakdown {
  switch (breakdown.kind) {
    case 'none':
      return { kind: 'none' };
    case 'severity':
      return config.columns.severity ? { kind: 'severity', expr: config.columns.severity } : { kind: 'none' };
    case 'field':
      return { kind: 'field', expr: breakdown.field.sqlExpr };
  }
}

export interface FieldTopValuesOpts {
  /** Table to sample from (e.g. config.logsTable). */
  table: string;
  /** Pre-built WHERE conditions (from buildWhereConditions). */
  conditions: string[];
  limit?: number;
  sampleSize?: number;
}

export function buildFieldTopValuesQuery(
  config: SourceConfig,
  sqlExpr: string,
  opts: FieldTopValuesOpts
): string {
  const { table, conditions, limit = 10, sampleSize = 500 } = opts;
  const tbl = tableRef(config, table);
  const tsCol = config.columns.timestamp;

  // Sample the most-recent sampleSize rows then aggregate within the sample.
  // Keeps query cost O(sampleSize) regardless of table size.
  // The scalar subquery returns total sampled rows so the UI can show
  // "Calculated from N records" with real percentages.
  const condClause = conditions.length > 0 ? `  WHERE ${conditions.join(' AND ')}` : null;
  return withSettings(
    [
      `WITH sample AS (`,
      `  SELECT toString(${sqlExpr}) AS value`,
      `  FROM ${tbl}`,
      condClause,
      tsCol ? `  ORDER BY ${tsCol} DESC` : null,
      `  LIMIT ${sampleSize}`,
      `)`,
      `SELECT value, count() AS count, sum(count()) OVER () AS total`,
      `FROM sample`,
      // notEmpty() alone lets through non-null-but-meaningless stand-ins for "absent" — a JSON
      // path missing from a given row's dynamic structure can stringify to '{}', '[]', or the
      // literal text 'null' rather than SQL NULL/''. Exclude those too, or a field made mostly of
      // rows without that path renders as if every sampled value were "empty."
      `WHERE notEmpty(value) AND value NOT IN ('{}', '[]', 'null')`,
      `GROUP BY value`,
      `ORDER BY count DESC`,
      `LIMIT ${limit}`,
    ],
    configSettingsFragments(config)
  );
}

export function buildSurroundingDocsQuery(
  config: SourceConfig,
  rowTimestamp: string,
  n = 25,
  direction: 'before' | 'after' = 'before'
): string {
  const c = config.columns;
  // Finding "surrounding" docs is inherently a time-proximity query — meaningless without a
  // mapped timestamp column, so gate the whole function rather than emit `undefined` into SQL.
  if (!c.timestamp) {
    return '';
  }
  const tbl = tableRef(config, config.logsTable);
  const op = direction === 'before' ? '<' : '>';
  const order = direction === 'before' ? 'DESC' : 'ASC';

  return withSettings(
    [
      `SELECT ${c.timestamp} AS timestamp, ${c.body || "''"} AS body,`,
      `  ${c.severity || "''"} AS severity, ${c.serviceName || "''"} AS serviceName`,
      `FROM ${tbl}`,
      `WHERE ${c.timestamp} ${op} ${quoteString(rowTimestamp)}`,
      `ORDER BY ${c.timestamp} ${order}`,
      `LIMIT ${n}`,
    ],
    configSettingsFragments(config)
  );
}
