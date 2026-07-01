import { SourceConfig } from '../types';

export type FieldKind = 'text' | 'exact' | 'map';

export interface ResolvedField {
  sqlExpr: string;
  kind: FieldKind;
}

/**
 * Resolve a user-typed field name to a SQL expression + kind.
 * No hardcoded aliases — the field name must match a mapped column (case-insensitive),
 * already be a raw expression, or fall back to a Map attribute lookup.
 * Returns null for unknown fields → callers fall back to free-text body search.
 */
export function resolveField(rawField: string, config: SourceConfig): ResolvedField | null {
  const f = rawField.trim().toLowerCase();
  const c = config.columns;

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
  const raw = rawField.trim();
  if (raw.includes('[') || raw.includes('(')) {
    return { sqlExpr: raw, kind: raw.includes('[') ? 'map' : 'exact' };
  }

  // Dotted key → Map attribute lookup (logAttributes preferred, then resourceAttributes)
  const mapCol = c.logAttributes || c.resourceAttributes;
  if (mapCol && rawField.includes('.')) {
    return { sqlExpr: `${mapCol}['${rawField}']`, kind: 'map' };
  }

  // Single-word unknown → try logAttributes Map access if available
  if (mapCol) {
    return { sqlExpr: `${mapCol}['${rawField}']`, kind: 'map' };
  }

  return null;
}
