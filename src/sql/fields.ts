import { SourceConfig } from '../types';
import { FieldModel } from './fieldModel';

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
}

export function buildFieldIndex(fields: FieldModel[]): FieldIndex {
  const bySqlExpr = new Map<string, FieldModel>();
  const byName = new Map<string, FieldModel>();
  for (const field of fields) {
    bySqlExpr.set(field.sqlExpr, field);
    byName.set(field.name.toLowerCase(), field);
    const dn = field.displayName.toLowerCase();
    if (!byName.has(dn)) {
      byName.set(dn, field);
    }
  }
  return { bySqlExpr, byName };
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
    const byName = index.byName.get(f);
    // Map fields are deliberately excluded from name-based resolution — typing a bare/dotted
    // key ("http.method") used to resolve it by matching FieldModel.name, which reads as
    // shorthand syntax but is really just a coincidence of indexing. Explicit bracket syntax
    // (Col['key'], handled below) or picking the field from autocomplete/sidebar (which now
    // inserts the real sqlExpr, not the bare name — see suggest.ts) are the only ways to resolve
    // a Map field. JSON/column fields keep name-based resolution — JSON's dotted sqlExpr already
    // matches what a user would naturally type, so it's not a guess in the same sense.
    if (byName && byName.source !== 'map') {
      return { sqlExpr: byName.sqlExpr, kind: kindForField(byName, config) };
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

  // Already a Map accessor like ResourceAttributes['key'] or a function call — pass through
  if (raw.includes('[') || raw.includes('(')) {
    return { sqlExpr: raw, kind: raw.includes('[') ? 'map' : 'exact' };
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
