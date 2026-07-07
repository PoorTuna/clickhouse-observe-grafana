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
