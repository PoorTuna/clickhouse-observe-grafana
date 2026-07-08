export type FieldType = 'time' | 'number' | 'string' | 'boolean' | 'map' | 'json' | 'unknown';

export interface FieldModel {
  id: string;           // stable: 'col:ServiceName' | 'map:LogAttributes:http.method' | 'json:Payload:user.id'
  name: string;         // 'ServiceName' | 'http.method' | 'user.id'
  displayName: string;
  sqlExpr: string;      // SQL expression for SELECT / WHERE
  type: FieldType;
  source: 'column' | 'map' | 'json';
  mapColumn?: string;   // 'LogAttributes' — set when source === 'map'
  jsonColumn?: string;  // 'Payload' — set when source === 'json'
  jsonPath?: string;    // 'user.id' — set when source === 'json'
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
