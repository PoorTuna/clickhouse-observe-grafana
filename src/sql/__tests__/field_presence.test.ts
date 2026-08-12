import { buildFieldPresenceQuery, MAX_PRESENCE_AGGREGATES, PRESENCE_SAMPLE_ROWS } from '../presence';
import { EMPTY_COLUMN_MAPPING, LogsQueryState, SourceConfig } from '../../types';
import { FieldModel } from '../fieldModel';
import { KqlSyntaxError } from '../kql';

const config: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'logs',
  isOtel: false,
  columns: { ...EMPTY_COLUMN_MAPPING, timestamp: 'Timestamp' },
};

const emptyState: LogsQueryState = { search: '', filters: [], rawSql: '', useRawSql: false, limit: 200, columns: [] };

const stringCol: FieldModel = { id: 'col:SeverityText', name: 'SeverityText', displayName: 'SeverityText', sqlExpr: 'SeverityText', type: 'string', source: 'column' };
const numberCol: FieldModel = { id: 'col:Duration', name: 'Duration', displayName: 'Duration', sqlExpr: 'Duration', type: 'number', source: 'column' };
const mapField: FieldModel = { id: 'map:LogAttributes:http.method', name: 'http.method', displayName: 'LogAttributes.http.method', sqlExpr: "LogAttributes['http.method']", type: 'string', source: 'map', mapColumn: 'LogAttributes' };
const mapField2: FieldModel = { id: 'map:LogAttributes:http.status', name: 'http.status', displayName: 'LogAttributes.http.status', sqlExpr: "LogAttributes['http.status']", type: 'string', source: 'map', mapColumn: 'LogAttributes' };
const jsonField: FieldModel = { id: 'json:Payload:user.id', name: 'user.id', displayName: 'Payload.user.id', sqlExpr: "Payload.user.id", type: 'string', source: 'json', jsonColumn: 'Payload', jsonPath: 'user.id' };
const tupleField: FieldModel = { id: 'tuple:Coords:x', name: 'x', displayName: 'Coords.x', sqlExpr: 'Coords.x', type: 'number', source: 'tuple', tupleColumn: 'Coords' };

describe('buildFieldPresenceQuery', () => {
  it('returns null when there are no fields to ask about', () => {
    expect(buildFieldPresenceQuery(config, emptyState, [])).toBeNull();
  });

  it('emits countIf for a scalar column, with a != \'\' conjunct for string type', () => {
    const q = buildFieldPresenceQuery(config, emptyState, [stringCol, numberCol])!;
    expect(q.sql).toContain(`countIf(SeverityText IS NOT NULL AND SeverityText != '') AS p0`);
    expect(q.sql).toContain(`countIf(Duration IS NOT NULL) AS p1`);
    expect(q.columnAliases.get(stringCol.id)).toBe('p0');
    expect(q.columnAliases.get(numberCol.id)).toBe('p1');
  });

  it('emits one groupUniqArrayArray(mapKeys(...)) per distinct Map column, not per key', () => {
    const q = buildFieldPresenceQuery(config, emptyState, [mapField, mapField2])!;
    const matches = q.sql.match(/groupUniqArrayArray\(mapKeys\(LogAttributes\)\)/g);
    expect(matches).toHaveLength(1);
    expect(q.mapKeyAliases.get('LogAttributes')).toBeDefined();
  });

  it('emits groupUniqArrayArray(JSONAllPaths(...)) for a JSON column', () => {
    const q = buildFieldPresenceQuery(config, emptyState, [jsonField])!;
    expect(q.sql).toContain('groupUniqArrayArray(JSONAllPaths(Payload))');
    expect(q.jsonPathAliases.get('Payload')).toBeDefined();
  });

  it('reads a tuple element off its parent column, aliased like a scalar column', () => {
    const q = buildFieldPresenceQuery(config, emptyState, [tupleField])!;
    expect(q.sql).toContain('countIf(Coords.x IS NOT NULL) AS p0');
    expect(q.sql).toContain('SELECT Coords');
    expect(q.columnAliases.get(tupleField.id)).toBe('p0');
  });

  it('includes the current WHERE conditions and samples the newest N matching rows', () => {
    const state: LogsQueryState = { ...emptyState, search: 'SeverityText:error' };
    const q = buildFieldPresenceQuery(config, state, [stringCol])!;
    expect(q.sql).toContain('WHERE');
    expect(q.sql).toContain(`ORDER BY Timestamp DESC`);
    expect(q.sql).toContain(`LIMIT ${PRESENCE_SAMPLE_ROWS}`);
  });

  it('drops the ORDER BY sample ordering when no timestamp is mapped', () => {
    const noTsConfig: SourceConfig = { ...config, columns: { ...EMPTY_COLUMN_MAPPING } };
    const q = buildFieldPresenceQuery(noTsConfig, emptyState, [stringCol])!;
    expect(q.sql).not.toContain('ORDER BY');
    expect(q.sql).toContain(`LIMIT ${PRESENCE_SAMPLE_ROWS}`);
  });

  it('caps the number of presence aggregates emitted, past which fields are simply omitted', () => {
    const manyFields: FieldModel[] = Array.from({ length: MAX_PRESENCE_AGGREGATES + 20 }, (_, i) => ({
      id: `col:f${i}`,
      name: `f${i}`,
      displayName: `f${i}`,
      sqlExpr: `f${i}`,
      type: 'string' as const,
      source: 'column' as const,
    }));
    const q = buildFieldPresenceQuery(config, emptyState, manyFields)!;
    expect(q.columnAliases.size).toBe(MAX_PRESENCE_AGGREGATES);
  });

  it('propagates a KqlSyntaxError from an unparseable search instead of building a wrong query', () => {
    const state: LogsQueryState = { ...emptyState, search: 'level:error AND' };
    expect(() => buildFieldPresenceQuery(config, state, [stringCol])).toThrow(KqlSyntaxError);
  });
});
