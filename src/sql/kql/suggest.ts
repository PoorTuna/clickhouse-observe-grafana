/**
 * KQL autocomplete suggestion engine.
 *
 * Mirrors elastic/kibana kql/public/autocomplete/providers/kql_query_suggestion/:
 *
 *   field       – matching field names, insert "fieldName " (trailing space)
 *   operator    – :  >=  <=  >  <  :*   with Kibana's exact insert-text + descriptions
 *   value       – top distinct values from ClickHouse, insert '"value" ' (quoted)
 *   conjunction – "and " / "or "
 *
 * getSuggestions() is synchronous (uses already-loaded values).
 * resolveValueContext() exposes which field + prefix needs an async value fetch.
 */

import { lex } from './_lexer';
import { FieldModel } from '../fieldModel';
import { FieldValue } from './_values';

export type SuggestionType = 'field' | 'operator' | 'value' | 'conjunction';

export interface Suggestion {
  type: SuggestionType;
  text: string;          // display text
  description?: string;  // shown on the right
  insertText: string;    // string to splice into the query (Kibana-exact)
  replaceStart: number;  // offset in the original query string
  replaceEnd: number;    // offset in the original query string (= cursor when inserting)
}

/** Describes what value data is still needed from ClickHouse. */
export interface ValueContext {
  fieldName: string;
  sqlExpr: string;
  prefix: string;       // text already typed after the colon
  replaceStart: number; // where the partial value starts
  replaceEnd: number;   // = cursor
}

export interface SuggestResult {
  suggestions: Suggestion[];
  valueContext?: ValueContext;
}

// ── Operator table (exact Kibana insert-text and descriptions) ─────────────

const OPERATORS = [
  { text: ':',    description: 'equals some value',             insert: ': '   },
  { text: ':*',   description: 'exists in any form',            insert: ':* '  },
  { text: '>=',   description: 'is greater than or equal to',   insert: '>= '  },
  { text: '<=',   description: 'is less than or equal to',      insert: '<= '  },
  { text: '>',    description: 'is greater than',               insert: '> '   },
  { text: '<',    description: 'is less than',                  insert: '< '   },
];

const CONJUNCTIONS = [
  { text: 'and', description: 'Requires both arguments to be true',          insert: 'and ' },
  { text: 'or',  description: 'Requires one or more arguments to be true',   insert: 'or '  },
];

// ── Main API ─────────────────────────────────────────────────────────────────

/**
 * Compute suggestions for the given cursor position.
 *
 * @param query    The full query string
 * @param cursor   Cursor position (0 = start of string)
 * @param fields   Available field models (from useFields())
 * @param values   Pre-fetched values to inject (pass [] until async fetch completes)
 */
export function getSuggestions(
  query: string,
  cursor: number,
  fields: FieldModel[],
  values: FieldValue[] = []
): SuggestResult {
  const text = query.slice(0, cursor);
  const tailsSpace = /\s$/.test(text);

  // Tokenize just the text before the cursor for context detection.
  const rawTokens = lex(text);
  const tokens = rawTokens.filter((t) => t.type !== 'EOF');

  const last  = tokens[tokens.length - 1];
  const prev  = tokens[tokens.length - 2];
  const prev2 = tokens[tokens.length - 3];

  // ── Nothing typed yet ─────────────────────────────────────────────────────
  if (!last) {
    return { suggestions: fieldSuggestions(fields, '', cursor, cursor) };
  }

  // ── After AND / OR / NOT keyword ──────────────────────────────────────────
  if (last.type === 'AND' || last.type === 'OR' || last.type === 'NOT') {
    return { suggestions: fieldSuggestions(fields, '', cursor, cursor) };
  }

  // ── After COLON: suggest values (empty prefix) ───────────────────────────
  if (last.type === 'COLON' && prev?.type === 'IDENT') {
    const fieldName = prev.value;
    const sqlExpr = fieldSqlExpr(fieldName, fields);
    const valueCtx: ValueContext = { fieldName, sqlExpr, prefix: '', replaceStart: cursor, replaceEnd: cursor };
    const valueSugg = values
      .filter((v) => v.value !== '')
      .map((v) => valueToSuggestion(v, cursor, cursor));
    return { suggestions: valueSugg, valueContext: valueCtx };
  }

  // ── IDENT after COLON: value typing or completed value ──────────────────
  if (last.type === 'IDENT' && prev?.type === 'COLON' && prev2?.type === 'IDENT') {
    if (tailsSpace) {
      // `field:value ` (space after value) → user is done with the value
      return { suggestions: conjunctionSuggestions(cursor) };
    }
    const prefix = last.value;
    const fieldName = prev2.value;
    const sqlExpr = fieldSqlExpr(fieldName, fields);
    const valueCtx: ValueContext = { fieldName, sqlExpr, prefix, replaceStart: last.start, replaceEnd: cursor };
    const lp = prefix.toLowerCase();
    const valueSugg = values
      .filter((v) => v.value !== '' && v.value.toLowerCase().includes(lp))
      .map((v) => valueToSuggestion(v, last.start, cursor));
    return { suggestions: valueSugg, valueContext: valueCtx };
  }

  // ── IDENT with trailing space (field typed, not after colon) ─────────────
  if (last.type === 'IDENT' && tailsSpace) {
    // `fieldName ` → suggest operators
    return { suggestions: operatorSuggestions(cursor) };
  }

  // ── RPAREN / QUOTED with trailing space → conjunctions ───────────────────
  if ((last.type === 'RPAREN' || last.type === 'QUOTED') && tailsSpace) {
    return { suggestions: conjunctionSuggestions(cursor) };
  }

  // ── IDENT being typed (no trailing space) ─────────────────────────────────
  if (last.type === 'IDENT' && !tailsSpace) {
    const afterConjOrStart =
      !prev ||
      prev.type === 'AND' ||
      prev.type === 'OR'  ||
      prev.type === 'NOT' ||
      prev.type === 'LPAREN';
    if (afterConjOrStart) {
      return { suggestions: fieldSuggestions(fields, last.value, last.start, cursor) };
    }
    // After an unknown context — still suggest fields as a safe fallback
    return { suggestions: fieldSuggestions(fields, last.value, last.start, cursor) };
  }

  // ── RPAREN / QUOTED without trailing space → also offer conjunctions ──────
  if (last.type === 'RPAREN' || last.type === 'QUOTED') {
    return { suggestions: conjunctionSuggestions(cursor) };
  }

  return { suggestions: [] };
}

/**
 * Expose the value-context from a previous getSuggestions call so the
 * caller can decide whether to fire an async value fetch.
 */
export function resolveValueContext(
  query: string,
  cursor: number,
  fields: FieldModel[]
): ValueContext | undefined {
  return getSuggestions(query, cursor, fields, []).valueContext;
}

// ── Builders ──────────────────────────────────────────────────────────────────

function fieldSuggestions(
  fields: FieldModel[],
  prefix: string,
  replaceStart: number,
  replaceEnd: number
): Suggestion[] {
  const lp = prefix.toLowerCase();
  return fields
    .filter((f) => f.name.toLowerCase().includes(lp) || f.displayName.toLowerCase().includes(lp))
    .sort((a, b) => {
      // Prefix-first (Kibana's sortPrefixFirst)
      const aStarts = a.name.toLowerCase().startsWith(lp) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(lp) ? 0 : 1;
      return aStarts - bStarts || a.name.localeCompare(b.name);
    })
    .map<Suggestion>((f) => ({
      type: 'field',
      text: f.name,
      description: f.type,
      // Kibana: insert name + space
      insertText: f.name + ' ',
      replaceStart,
      replaceEnd,
    }));
}

function operatorSuggestions(cursor: number): Suggestion[] {
  return OPERATORS.map<Suggestion>((op) => ({
    type: 'operator',
    text: op.text,
    description: op.description,
    insertText: op.insert,
    replaceStart: cursor,
    replaceEnd: cursor,
  }));
}

function conjunctionSuggestions(cursor: number): Suggestion[] {
  return CONJUNCTIONS.map<Suggestion>((c) => ({
    type: 'conjunction',
    text: c.text,
    description: c.description,
    insertText: c.insert,
    replaceStart: cursor,
    replaceEnd: cursor,
  }));
}

function valueToSuggestion(v: FieldValue, replaceStart: number, replaceEnd: number): Suggestion {
  // Kibana: wrap in quotes + trailing space
  const escaped = v.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return {
    type: 'value',
    text: v.value,
    description: String(v.count),
    insertText: `"${escaped}" `,
    replaceStart,
    replaceEnd,
  };
}

function fieldSqlExpr(fieldName: string, fields: FieldModel[]): string {
  const found = fields.find(
    (f) => f.name === fieldName || f.displayName === fieldName
  );
  return found?.sqlExpr ?? fieldName;
}
