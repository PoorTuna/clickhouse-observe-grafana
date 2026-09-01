import { SourceConfig } from '../types';
import { FieldModel } from './fieldModel';
import { looksLikeMapAccessor, quoteString } from './queryBuilder';

export type FieldKind = 'text' | 'exact' | 'map' | 'json';

export interface ResolvedField {
  sqlExpr: string;
  kind: FieldKind;
}

/**
 * Lookup index over discovered fields (columns, Map keys, JSON paths) — built once per
 * fields list via buildFieldIndex() and threaded through resolveField()/kqlToSql() so a
 * dotted name can be resolved unambiguously.
 *
 * Why this is needed: a JSON path's sqlExpr ("Payload.user.id") and a bare dotted attribute
 * name typed into KQL ("user.id", meant as a Map lookup) are string-indistinguishable —
 * both are just "identifier.identifier". Without consulting what fields were actually
 * discovered, resolveField's heuristics alone can't tell them apart, and would wrongly
 * re-wrap an already-resolved JSON accessor as a Map lookup (`LogAttributes['Payload.user.id']`).
 */
export interface FieldIndex {
  /** Keyed by exact sqlExpr — catches already-resolved expressions passed back in (e.g. a
   *  FilterPill built directly from FieldModel.sqlExpr, same pattern Map filters already use). */
  bySqlExpr: Map<string, FieldModel>;
  /** Keyed by lowercased name/displayName — catches a field typed by name in KQL/filter shorthand. */
  byName: Map<string, FieldModel>;
  /** Keyed by lowercased displayName only (the source-column-prefixed form, e.g.
   *  "ResourceAttributes.k8s.namespace.name") — unlike `byName`, this resolves Map fields too,
   *  since a full displayName names its source column explicitly and isn't the "guess which Map
   *  a bare key came from" case `byName` deliberately refuses for Map (see resolveField below). */
  byDisplayName: Map<string, FieldModel>;
  /** Map *container* columns only (source === 'column', type === 'map'), keyed by their original-
   *  case name. Backs resolveField's `<mapColumn>.<key>` fallback below: a Map column's leaf keys
   *  are never individually discovered/published the way JSON paths are (listing them costs a row
   *  scan — see sql/keys.ts), so a dotted name the user typed or accepted from the search bar's
   *  on-demand key browse (SearchBar.tsx) needs to resolve even when that exact key never made it
   *  into `fields`. */
  mapColumns: FieldModel[];
}

export function buildFieldIndex(fields: FieldModel[]): FieldIndex {
  const bySqlExpr = new Map<string, FieldModel>();
  const byName = new Map<string, FieldModel>();
  const byDisplayName = new Map<string, FieldModel>();
  const mapColumns: FieldModel[] = [];
  for (const field of fields) {
    bySqlExpr.set(field.sqlExpr, field);
    byName.set(field.name.toLowerCase(), field);
    const dn = field.displayName.toLowerCase();
    if (!byName.has(dn)) {
      byName.set(dn, field);
    }
    if (!byDisplayName.has(dn)) {
      byDisplayName.set(dn, field);
    }
    if (field.source === 'column' && field.type === 'map') {
      mapColumns.push(field);
    }
  }
  return { bySqlExpr, byName, byDisplayName, mapColumns };
}

/**
 * Matches `rawField` against `<mapColumn>.<rest>` for every discovered Map container column,
 * returning the LONGEST matching container name — the deterministic tie-break for the (legal,
 * rare) case of a schema having both a Map column `A` and another column literally named `A.B`:
 * the longer, more specific name wins, same rule resolveField already applies via
 * byDisplayName/byName precedence over this fallback.
 */
function matchMapKeyPath(rawField: string, mapColumns: FieldModel[]): { column: FieldModel; key: string } | null {
  let best: { column: FieldModel; key: string } | null = null;
  for (const column of mapColumns) {
    const prefix = `${column.name}.`;
    if (rawField.length > prefix.length && rawField.toLowerCase().startsWith(prefix.toLowerCase())) {
      if (!best || column.name.length > best.column.name.length) {
        best = { column, key: rawField.slice(prefix.length) };
      }
    }
  }
  return best;
}

function kindForField(field: FieldModel, config: SourceConfig): FieldKind {
  if (field.source === 'json') {
    return 'json';
  }
  if (field.source === 'map') {
    return 'map';
  }
  return field.sqlExpr === config.columns.body ? 'text' : 'exact';
}

/**
 * Resolve a user-typed field name to a SQL expression + kind.
 * When `index` is supplied (built from useFields() via buildFieldIndex), discovered fields —
 * including JSON paths — are matched first. Falls back to the config-only heuristics below when
 * there's no match (or no index was supplied), preserving existing behavior for callers that
 * don't yet thread field discovery through (e.g. dashboard-panel export).
 */
export function resolveField(rawField: string, config: SourceConfig, index?: FieldIndex): ResolvedField | null {
  const raw = rawField.trim();
  const f = raw.toLowerCase();
  const c = config.columns;

  if (index) {
    const bySqlExpr = index.bySqlExpr.get(raw);
    if (bySqlExpr) {
      return { sqlExpr: bySqlExpr.sqlExpr, kind: kindForField(bySqlExpr, config) };
    }
    // Full displayName match ("ResourceAttributes.http.method") — unlike a bare key, this names
    // its source column explicitly, so it resolves for every source including Map. This is what
    // autocomplete now inserts verbatim (see suggest.ts's fieldSuggestions), so accepting a
    // suggestion always resolves back to the same field it showed.
    const byDisplayName = index.byDisplayName.get(f);
    if (byDisplayName) {
      return { sqlExpr: byDisplayName.sqlExpr, kind: kindForField(byDisplayName, config) };
    }
    const byName = index.byName.get(f);
    // Map fields are deliberately excluded from bare-name resolution — typing a bare/dotted
    // key ("http.method") used to resolve it by matching FieldModel.name, which reads as
    // shorthand syntax but is really just a coincidence of indexing. Explicit bracket syntax
    // (Col['key'], handled below) or the full displayName (handled above) are the only ways to
    // resolve a Map field. JSON/column fields keep name-based resolution — JSON's dotted sqlExpr
    // already matches what a user would naturally type, so it's not a guess in the same sense.
    if (byName && byName.source !== 'map') {
      return { sqlExpr: byName.sqlExpr, kind: kindForField(byName, config) };
    }

    // `<mapColumn>.<key>` — the natural dotted form the search bar's dot-drilldown autocomplete
    // inserts (SearchBar.tsx) and a user would type by hand, for a key that was never individually
    // discovered (Map keys are sample-scoped and live in sql/keys.ts's cache, not in `fields` — see
    // that module's doc comment for why). Without this, such a name misses every lookup above and
    // used to silently degrade to a body ILIKE search (kql/toSql.ts) instead of the Map lookup it
    // obviously means — a real key typed correctly returned zero rows with no error. Checked last,
    // after byDisplayName/byName, so a real column, Tuple element, or JSON path with the same
    // dotted shape always wins first.
    const mapKeyMatch = matchMapKeyPath(raw, index.mapColumns);
    if (mapKeyMatch) {
      return { sqlExpr: `${mapKeyMatch.column.name}[${quoteString(mapKeyMatch.key)}]`, kind: 'map' };
    }
  }

  // Direct column mapping match (case-insensitive).
  // The mapped body column is known to hold free text, so it keeps 'text'
  // semantics (substring/word-boundary search) when referenced by name —
  // every other mapped column is an exact-match field.
  for (const [key, colExpr] of Object.entries(c)) {
    if (typeof colExpr === 'string' && colExpr.toLowerCase() === f) {
      return { sqlExpr: colExpr, kind: key === 'body' ? 'text' : 'exact' };
    }
  }

  // Already a well-formed Map accessor (ResourceAttributes['key']) — pass through. Uses a strict
  // shape check (looksLikeMapAccessor, queryBuilder.ts) rather than a loose "contains a special
  // character" test — the old `raw.includes('[') || raw.includes('(')` check trusted *any* string
  // containing those characters, including raw untrusted text like `x) OR 1=1 -- (`, and
  // interpolated it unquoted (see C1 in the audit plan). A bare function-call passthrough
  // (previously `kind: 'exact'` on any string with `(`) is dropped entirely: anyone who needs an
  // arbitrary function-call expression already has raw-SQL mode as the sanctioned escape hatch.
  //
  // Deliberately does NOT also recognize a bare dotted chain like `user.id` here — without field
  // discovery (`index`) confirming such a name is a real JSON/Tuple path, treating it as one would
  // be exactly the "blind guessing" the comment below already warns against. A *discovered* dotted
  // path still works correctly: it's matched and returned above, via `index.bySqlExpr`/
  // `index.byName`, before this branch is ever reached.
  if (looksLikeMapAccessor(raw)) {
    return { sqlExpr: raw, kind: 'map' };
  }

  // No blind Map-column guessing beyond this point — a field name that doesn't match a discovered
  // field (via `index`, checked above) or an exact config-column name is genuinely unresolved.
  // This used to fall back to `(logAttributes || resourceAttributes)['field']` — silently guessing
  // a Map column with no signal when the guess was wrong (query runs, returns nothing, no error).
  // Callers already degrade gracefully on `null` (treat the field name as a direct column
  // reference — see kqlIsToSql/kqlRangeToSql in kql/toSql.ts, buildFilterClause in queryBuilder.ts)
  // which surfaces a real ClickHouse error for a genuinely unknown field instead of a silent
  // empty result — explicit `Col['key']` bracket syntax above, or real field discovery, are the
  // only ways to resolve a Map field now.
  return null;
}
