export type FieldType = 'time' | 'number' | 'string' | 'boolean' | 'map' | 'json' | 'tuple' | 'array' | 'unknown';

export interface FieldModel {
  id: string;           // stable: 'col:ServiceName' | 'map:LogAttributes:http.method' | 'json:Payload:user.id' | 'tuple:MyTuple:a'
  name: string;         // 'ServiceName' | 'http.method' | 'user.id' | 'a'
  displayName: string;
  sqlExpr: string;      // SQL expression for SELECT / WHERE
  type: FieldType;
  source: 'column' | 'map' | 'json' | 'tuple';
  mapColumn?: string;   // 'LogAttributes' — set when source === 'map'
  jsonColumn?: string;  // 'Payload' — set when source === 'json'
  jsonPath?: string;    // 'user.id' — set when source === 'json'
  tupleColumn?: string; // 'MyTuple' — set when source === 'tuple'
  /** Raw ClickHouse type string (e.g. "Tuple(a String, b Int64)") — set on source === 'column'
   *  entries so it survives the columnCache and stays available for parseTupleElements() even on
   *  a cache hit, where the original system.columns rows aren't re-fetched. */
  rawType?: string;
}

/** Strip ClickHouse type wrappers and infer a semantic FieldType. */
export function inferFieldType(chType: string): FieldType {
  const inner = chType.replace(/LowCardinality\(|Nullable\(/g, '').replace(/\)+$/, '');
  if (/^DateTime/.test(inner) || inner === 'Date') {
    return 'time';
  }
  if (/^(U?Int\d+|Float\d+|Decimal)/.test(inner)) {
    return 'number';
  }
  if (/^Bool/.test(inner)) {
    return 'boolean';
  }
  if (/^Map\(/.test(chType)) {
    return 'map';
  }
  // Checked against the raw type string, same reasoning as the JSON check below: a Tuple's own
  // trailing `)` is part of its own syntax, not a wrapper the top of this function should strip.
  if (/^Tuple\(/.test(chType)) {
    return 'tuple';
  }
  // Array(...) — includes ClickHouse Nested(...) columns, which system.columns already flattens
  // into dotted Array(T) rows (e.g. a `Nested(a String, b Int64)` column named `N` shows up as two
  // separate rows `N.a Array(String)` / `N.b Array(Int64)`, not as one Nested-typed row) — those
  // dotted rows were already reaching Phase A as ordinary columns before this branch existed, just
  // silently falling through to 'unknown'. Also covers Array(Tuple(...)) (array-of-tuples): typed
  // 'array' rather than descending into the element Tuple — full per-row flattening of an array of
  // structs needs arrayMap/tupleElement SQL, a materially bigger feature than this fixes; this only
  // makes such a column visible/selectable as a raw array instead of an unlabeled 'unknown'.
  if (/^Array\(/.test(chType)) {
    return 'array';
  }
  // Native ClickHouse JSON type, e.g. `JSON`, `JSON(max_dynamic_paths=100)`,
  // `JSON(user.id UInt32)`. Older syntax `Object('json')` is equivalent — treat both the same.
  // Checked against the raw type string (not `inner`) since the trailing-`)` strip above would
  // otherwise mangle Object('json')'s closing parens.
  if (/^JSON\b/.test(inner) || /^Object\('json'\)/.test(chType)) {
    return 'json';
  }
  if (/^(String|UUID|IPv4|IPv6|Enum|FixedString)/.test(inner)) {
    return 'string';
  }
  return 'unknown';
}

/**
 * Narrows a list of configured attribute-column names down to the ones that are actually
 * Map-typed per the discovered columns. Map-key discovery (`mapKeys(...)`) throws
 * `ILLEGAL_TYPE_OF_ARGUMENT` (ClickHouse error 43) if run against a non-Map column — e.g. when a
 * schema stores ResourceAttributes/LogAttributes/ScopeAttributes as JSON or String instead of the
 * OTel-default Map(String,String). Mirrors the type gate JSON-path discovery already applies via
 * `columns.filter((f) => f.type === 'json')`.
 */
export function selectMapColumns(configuredNames: Array<string | undefined>, columns: FieldModel[]): string[] {
  const mapTypedNames = new Set(columns.filter((f) => f.type === 'map').map((f) => f.name));
  return configuredNames.filter((name): name is string => !!name && mapTypedNames.has(name));
}

/** Depth cap for recursive tuple flattening — real ClickHouse type strings are always finite
 *  (they mirror an actual finite schema), so this only guards against a malformed/adversarial
 *  type string, not any real nesting level a user would define. */
const MAX_TUPLE_DEPTH = 10;

/** Splits a comma-separated type-list string only on top-level commas (paren-depth 0) — an
 *  element's own type can itself contain commas (a nested Tuple/Map, or `Decimal(p, s)`), which a
 *  naive `.split(',')` would incorrectly break apart. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

/** Parses exactly one Tuple(...) level into its element name/type pairs, without recursing into
 *  nested Tuple elements — the building block parseTupleElements recurses on top of. */
function parseTupleLevel(chType: string): Array<{ name: string; type: string }> {
  const match = /^Tuple\((.*)\)$/.exec(chType.trim());
  if (!match) {
    return [];
  }
  return splitTopLevel(match[1])
    .map((part, i) => {
      const trimmed = part.trim();
      // A named element looks like `name Type` (identifier, whitespace, then the rest). An
      // unnamed element's type never has that identifier-then-space shape at its very start
      // (e.g. "Nullable(String)" has no space before its "(") — so this correctly falls through
      // to the positional case for unnamed elements.
      const nameMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/.exec(trimmed);
      if (nameMatch) {
        return { name: nameMatch[1], type: nameMatch[2].trim() };
      }
      return { name: String(i + 1), type: trimmed };
    })
    .filter((el) => el.type.length > 0);
}

/**
 * Parses a ClickHouse `Tuple(...)` type string into fully-flattened leaf name/type pairs —
 * recurses through any element that is itself a nested Tuple, producing dotted leaf names (e.g.
 * `Tuple(a Tuple(x Int64, y Int64))` → `a.x`, `a.y`), the same way Map keys and JSON paths already
 * get flattened into individually filterable/selectable fields (see FieldsContext.tsx's Phase D).
 * Unlike Map/JSON, no query is needed: the full element tree is already determined by the type
 * string `system.columns` returns for Phase A — this is a synchronous parse, not a scan.
 *
 * Named tuple:   "Tuple(a String, b Int64)" → [{name:'a',type:'String'}, {name:'b',type:'Int64'}]
 * Unnamed tuple: "Tuple(String, Int64)"     → [{name:'1',type:'String'}, {name:'2',type:'Int64'}]
 *   (positional names match ClickHouse's own `col.1`/`col.2` dot-access for unnamed tuples)
 * Nested tuple:  "Tuple(a Tuple(x Int64, y Int64), b String)"
 *                → [{name:'a.x',type:'Int64'}, {name:'a.y',type:'Int64'}, {name:'b',type:'String'}]
 * Mixed named/unnamed elements are handled per-element (ClickHouse allows this, though rare).
 *
 * Recursion is Tuple-into-Tuple only. An element whose own type is Map/JSON/Array (including
 * Array(Tuple(...)) — array-of-tuples) is a leaf here, not expanded further: Map/JSON already have
 * their own dedicated discovery phases (keyed by runtime scan, not static type parsing), and
 * array-of-tuples needs per-row SQL flattening (arrayMap/tupleElement) to be individually
 * filterable — a materially bigger feature than a static type-string parse can produce.
 */
export function parseTupleElements(
  chType: string,
  depth = 0
): Array<{ name: string; type: string }> {
  const level = parseTupleLevel(chType);
  if (depth >= MAX_TUPLE_DEPTH) {
    return level;
  }
  const leaves: Array<{ name: string; type: string }> = [];
  for (const el of level) {
    if (/^Tuple\(/.test(el.type)) {
      for (const nested of parseTupleElements(el.type, depth + 1)) {
        leaves.push({ name: `${el.name}.${nested.name}`, type: nested.type });
      }
    } else {
      leaves.push(el);
    }
  }
  return leaves;
}
