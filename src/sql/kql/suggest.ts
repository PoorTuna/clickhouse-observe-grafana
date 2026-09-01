/**
 * KQL autocomplete suggestion engine.
 *
 *   field       – matching field names, insert "fieldName " (trailing space)
 *   operator    – :  >=  <=  >  <  :*   with exact insert-text + descriptions
 *   value       – top distinct values from ClickHouse, insert '"value" ' (quoted)
 *   mapkey      – a Map column's leaf keys, insert "mapCol.key " (trailing space); accepting a Map
 *                 *container* field (fieldSuggestions, below) instead inserts "mapCol." with no
 *                 trailing space, so the same token immediately becomes a mapkey prefix
 *   conjunction – "and " / "or "
 *
 * getSuggestions() is synchronous (uses already-loaded values/keys).
 * resolveValueContext() exposes which field + prefix needs an async value fetch.
 * A returned SuggestResult.mapKeyContext exposes which Map column + key-prefix needs an async key
 * fetch — same shape/contract as valueContext, just backed by sql/keys.ts's loadColumnKeys instead
 * of kql/_values.ts's loadFieldValues. Map keys are never published into the discovered `fields`
 * list (they're sample-scoped, not schema — see sql/keys.ts's doc comment), so this engine accepts
 * them as a separate, caller-supplied lookup rather than finding them in `fields` the way a JSON
 * path or Tuple element already does.
 */

import { lex } from './_lexer';
import { FieldModel } from '../fieldModel';
import { FieldValue } from './_values';
import { escapeKqlIdent } from './_escape';
import { quoteString } from '../queryBuilder';

export type SuggestionType = 'field' | 'operator' | 'value' | 'mapkey' | 'conjunction';

export interface Suggestion {
  type: SuggestionType;
  text: string;          // display text
  description?: string;  // shown on the right
  insertText: string;    // string to splice into the query
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

/** Describes which Map column's key list is still needed from sql/keys.ts's loadColumnKeys. */
export interface MapKeyContext {
  column: string;       // the Map container column's name
  prefix: string;       // key text already typed after "column."
  replaceStart: number; // start of the whole "column.prefix" token
  replaceEnd: number;   // = cursor
}

export interface SuggestResult {
  suggestions: Suggestion[];
  valueContext?: ValueContext;
  mapKeyContext?: MapKeyContext;
}

// ── Operator table ───────────────────────────────────────────────────────

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
  { text: 'not', description: 'Negates the following expression',            insert: 'not ' },
];

// ── Main API ─────────────────────────────────────────────────────────────────

/**
 * Compute suggestions for the given cursor position.
 *
 * @param query    The full query string
 * @param cursor   Cursor position (0 = start of string)
 * @param fields   Available field models (from useFields())
 * @param values   Pre-fetched values to inject (pass [] until async fetch completes)
 * @param mapKeys  Pre-fetched Map key lists, keyed by container column name (pass an empty/absent
 *                 entry until the async key fetch for that column completes — mirrors `values`)
 */
export function getSuggestions(
  query: string,
  cursor: number,
  fields: FieldModel[],
  values: FieldValue[] = [],
  mapKeys?: Map<string, string[]>
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
    return { suggestions: [notSuggestion(cursor), ...fieldSuggestions(fields, '', cursor, cursor)] };
  }

  // ── After AND / OR keyword: fields + not ──────────────────────────────────
  if (last.type === 'AND' || last.type === 'OR') {
    return { suggestions: [notSuggestion(cursor), ...fieldSuggestions(fields, '', cursor, cursor)] };
  }

  // ── After NOT keyword: only fields ────────────────────────────────────────
  if (last.type === 'NOT') {
    return { suggestions: fieldSuggestions(fields, '', cursor, cursor) };
  }

  // ── After COLON: suggest values (empty prefix) ───────────────────────────
  if (last.type === 'COLON' && prev?.type === 'IDENT') {
    const fieldName = prev.value;
    const sqlExpr = fieldSqlExpr(fieldName, fields);
    const isNumeric = fieldTypeFor(fieldName, fields) === 'number';
    const valueCtx: ValueContext = { fieldName, sqlExpr, prefix: '', replaceStart: cursor, replaceEnd: cursor };
    const valueSugg = values
      .filter((v) => v.value !== '')
      .map((v) => valueToSuggestion(v, cursor, cursor, isNumeric));
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
    const isNumeric = fieldTypeFor(fieldName, fields) === 'number';
    const valueCtx: ValueContext = { fieldName, sqlExpr, prefix, replaceStart: last.start, replaceEnd: cursor };
    const lp = prefix.toLowerCase();
    const valueSugg = values
      .filter((v) => v.value !== '' && v.value.toLowerCase().includes(lp))
      .map((v) => valueToSuggestion(v, last.start, cursor, isNumeric));
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
    // Dot-drilldown into a Map column's keys — "LogAttributes." (just accepted the container
    // suggestion) or "LogAttributes.htt" (typing a key). Checked before the afterConjOrStart split
    // below since it applies at every position an IDENT can start (query start, after and/or/not,
    // after a paren) the same way. Unlike resolveField's matchMapKeyPath (sql/fields.ts), an empty
    // key prefix ("LogAttributes." with nothing after the dot) still matches here — that's exactly
    // the state right after accepting the container suggestion, when the key list should already
    // start populating.
    const mapMatch = matchMapKeyPrefix(last.value, fields);
    if (mapMatch) {
      const mapKeyCtx: MapKeyContext = {
        column: mapMatch.column,
        prefix: mapMatch.keyPrefix,
        replaceStart: last.start,
        replaceEnd: cursor,
      };
      const loadedKeys = mapKeys?.get(mapMatch.column);
      const keySugg =
        loadedKeys !== undefined
          ? mapKeySuggestions(mapMatch.column, loadedKeys, mapMatch.keyPrefix, last.start, cursor)
          : [];
      // Escape hatch: with nothing typed after the dot yet, also offer accepting the whole map
      // as-is (undoes the dot, same as pre-drilldown) — keeps "LogAttributes:*" reachable without
      // forcing the user to backspace over the dot first.
      const wholeMapSugg =
        mapMatch.keyPrefix === ''
          ? [
              {
                type: 'field' as const,
                text: mapMatch.column,
                description: 'map · whole column',
                insertText: escapeKqlIdent(mapMatch.column) + ' ',
                replaceStart: last.start,
                replaceEnd: cursor,
              },
            ]
          : [];
      // Still append ordinary field matches for the same typed text — a real dotted column or a
      // JSON/Tuple path that happens to share this prefix must keep showing, not be shadowed by
      // the Map-key context.
      const fieldSugg = fieldSuggestions(fields, last.value, last.start, cursor);
      return { suggestions: [...keySugg, ...wholeMapSugg, ...fieldSugg], mapKeyContext: mapKeyCtx };
    }

    const afterConjOrStart =
      !prev ||
      prev.type === 'AND' ||
      prev.type === 'OR'  ||
      prev.type === 'NOT' ||
      prev.type === 'LPAREN';
    if (afterConjOrStart) {
      const fieldSugg = fieldSuggestions(fields, last.value, last.start, cursor);
      // Offer 'not' if the partial text could be a prefix of it
      if ('not'.startsWith(last.value.toLowerCase())) {
        const not: Suggestion = {
          type: 'conjunction',
          text: 'not',
          description: 'Negates the following expression',
          insertText: 'not ',
          replaceStart: last.start,
          replaceEnd: cursor,
        };
        return { suggestions: [not, ...fieldSugg] };
      }
      return { suggestions: fieldSugg };
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
      // Prefix-first ranking. Checked against both the bare key and the
      // displayed (source-column-prefixed) name — a nested Map/JSON field's `name` is just the
      // leaf key ("k8s.namespace.name"), so typing the source column's prefix ("Resource…")
      // would otherwise never rank it as a prefix match even though that's what's on screen.
      const aStarts = a.name.toLowerCase().startsWith(lp) || a.displayName.toLowerCase().startsWith(lp) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(lp) || b.displayName.toLowerCase().startsWith(lp) ? 0 : 1;
      return aStarts - bStarts || a.name.localeCompare(b.name);
    })
    .map<Suggestion>((f) => {
      // A Map *container* column (source==='column', type==='map') has no single "value" of its
      // own to complete against — accepting it opens the dot-drilldown into its keys instead of
      // ending the field, so it inserts a trailing "." with no space rather than the usual
      // trailing space. The next getSuggestions() call (fired right after, see SearchBar's
      // applySuggestion) then matches matchMapKeyPrefix and switches into mapkey suggestions.
      const isMapContainer = f.source === 'column' && f.type === 'map';
      const displayed = isMapContainer ? `${f.displayName}.` : f.displayName;
      return {
        type: 'field',
        // Shown as-is to the user: for a Map/JSON key this is prefixed with its source column
        // ("ResourceAttributes.k8s.namespace.name") — same reasoning as the field sidebar, so this
        // never reads like a standalone top-level column that was made up.
        text: displayed,
        description: isMapContainer ? 'map · browse keys' : f.type,
        // Insert exactly what's shown — the displayName, escaped so it round-trips through the
        // lexer as one token (see _escape.ts). Previously this inserted the bare leaf key (or, for
        // Map fields, the bracket-accessor sqlExpr) instead of the prefixed name the user typed and
        // saw highlighted, silently deleting the "ResourceAttributes." / "Payload." prefix on
        // accept. resolveField (fields.ts) now resolves a full displayName directly — including for
        // Map fields, via its byDisplayName index — so no accessor rewrite is needed here anymore.
        insertText: isMapContainer ? escapeKqlIdent(f.displayName) + '.' : escapeKqlIdent(f.displayName) + ' ',
        replaceStart,
        replaceEnd,
      };
    });
}

/**
 * Matches `text` (the IDENT token currently being typed) against `<mapColumn>.<keyPrefix>` for
 * every discovered Map container field, longest-container-name-wins on a tie — same rule
 * resolveField's matchMapKeyPath (sql/fields.ts) uses, kept as a separate, deliberately looser
 * implementation here: unlike resolveField (which only ever sees a *complete* field reference), an
 * empty keyPrefix ("LogAttributes." with nothing typed after the dot yet) must still match, since
 * that's exactly the state immediately after accepting the container suggestion.
 */
function matchMapKeyPrefix(text: string, fields: FieldModel[]): { column: string; keyPrefix: string } | null {
  let best: { column: string; keyPrefix: string } | null = null;
  for (const f of fields) {
    if (f.source !== 'column' || f.type !== 'map') {
      continue;
    }
    const prefix = `${f.name}.`;
    if (text.toLowerCase().startsWith(prefix.toLowerCase())) {
      if (!best || f.name.length > best.column.length) {
        best = { column: f.name, keyPrefix: text.slice(prefix.length) };
      }
    }
  }
  return best;
}

/** Builds suggestions from an already-fetched Map key list, filtered/ranked by `keyPrefix` the
 *  same substring + prefix-first way fieldSuggestions ranks field names. */
function mapKeySuggestions(
  column: string,
  keys: string[],
  keyPrefix: string,
  replaceStart: number,
  replaceEnd: number
): Suggestion[] {
  const lp = keyPrefix.toLowerCase();
  return keys
    .filter((k) => k.toLowerCase().includes(lp))
    .sort((a, b) => {
      const aStarts = a.toLowerCase().startsWith(lp) ? 0 : 1;
      const bStarts = b.toLowerCase().startsWith(lp) ? 0 : 1;
      return aStarts - bStarts || a.localeCompare(b);
    })
    .map<Suggestion>((k) => ({
      type: 'mapkey',
      // Full prefixed form, same insert-equals-display contract as fieldSuggestions — accepting a
      // key never leaves the "column." prefix looking like it belongs to a different field.
      text: `${column}.${k}`,
      description: 'key',
      insertText: escapeKqlIdent(`${column}.${k}`) + ' ',
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

function notSuggestion(cursor: number): Suggestion {
  return {
    type: 'conjunction',
    text: 'not',
    description: 'Negates the following expression',
    insertText: 'not ',
    replaceStart: cursor,
    replaceEnd: cursor,
  };
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

// Matches Kibana's value-suggestion quoting (kql_query_suggestion/value.ts): a string value is
// always wrapped in quotes, a numeric value never is — and, same as Kibana, the *displayed*
// suggestion text is the exact string that gets inserted (no separate unquoted label), so
// accepting a suggestion never changes what was on screen.
function valueToSuggestion(v: FieldValue, replaceStart: number, replaceEnd: number, isNumeric: boolean): Suggestion {
  const inserted = isNumeric ? v.value : `"${v.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return {
    type: 'value',
    text: inserted,
    description: String(v.count),
    insertText: `${inserted} `,
    replaceStart,
    replaceEnd,
  };
}

function fieldSqlExpr(fieldName: string, fields: FieldModel[]): string {
  // displayName is unique per discovered field (source-column-prefixed for nested Map/JSON
  // keys); bare `name` is not — two different Map/JSON columns can both surface a leaf key
  // like "id". Check displayName first so an exact match there can't be shadowed by an
  // unrelated field that merely shares the same bare name.
  const found =
    fields.find((f) => f.displayName === fieldName) ?? fields.find((f) => f.name === fieldName);
  if (found) {
    return found.sqlExpr;
  }
  // Not a discovered field — a Map key never is (they're sample-scoped, not published into
  // `fields`; see sql/keys.ts). "ResourceAttributes.k8s.pod.name" reaches here whether it was
  // typed by hand or accepted from a mapkey suggestion (accepting one only inserts text, it
  // doesn't add anything to `fields`), so without this fallback the value fetch would run against
  // the literal string "ResourceAttributes.k8s.pod.name" as if it were a raw SQL expression —
  // invalid ClickHouse syntax, silently swallowed by loadFieldValues' try/catch into an empty
  // dropdown. Same longest-prefix rule as matchMapKeyPrefix's own callers.
  const mapMatch = matchMapKeyPrefix(fieldName, fields);
  if (mapMatch && mapMatch.keyPrefix !== '') {
    return `${mapMatch.column}[${quoteString(mapMatch.keyPrefix)}]`;
  }
  return fieldName;
}

/** Look up a typed field's FieldType by the same name-resolution order fieldSqlExpr uses, so the
 *  value-quoting decision (valueToSuggestion) matches whichever field the query will resolve to. */
function fieldTypeFor(fieldName: string, fields: FieldModel[]): FieldModel['type'] | undefined {
  const found =
    fields.find((f) => f.displayName === fieldName) ?? fields.find((f) => f.name === fieldName);
  if (found) {
    return found.type;
  }
  // A Map value is always a string (Map(String,String)) — never the 'number' type that would
  // make valueToSuggestion insert it unquoted.
  const mapMatch = matchMapKeyPrefix(fieldName, fields);
  return mapMatch && mapMatch.keyPrefix !== '' ? 'string' : undefined;
}
