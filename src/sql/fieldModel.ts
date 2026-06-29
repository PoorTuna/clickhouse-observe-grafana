export type FieldType = 'time' | 'number' | 'string' | 'boolean' | 'map' | 'unknown';

export interface FieldModel {
  id: string;           // stable: 'col:ServiceName' | 'map:LogAttributes:http.method'
  name: string;         // 'ServiceName' | 'http.method'
  displayName: string;
  sqlExpr: string;      // SQL expression for SELECT / WHERE
  type: FieldType;
  source: 'column' | 'map';
  mapColumn?: string;   // 'LogAttributes'
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
  if (/^(String|UUID|IPv4|IPv6|Enum|FixedString)/.test(inner)) {
    return 'string';
  }
  return 'unknown';
}
