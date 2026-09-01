/**
 * resolveField's Map-key fallback: `<mapColumn>.<key>` for a key that was never individually
 * discovered (a Map column's keys are sample-scoped, browsed lazily — sql/keys.ts — and are never
 * published into the discovered `fields` list the way a JSON path or Tuple element is). Before this
 * fallback existed, such a name missed every lookup in resolveField and the caller (kql/toSql.ts)
 * degraded it to a body ILIKE search instead of the Map lookup it obviously means — see
 * kql/__tests__/to_sql.test.ts's "never resolves to a Map accessor" tests for the (still-true) case
 * of a *bare*, unprefixed key, which this fallback deliberately does not touch.
 */
import { buildFieldIndex, resolveField } from '../fields';
import { FieldModel } from '../fieldModel';
import { SourceConfig, OTEL_COLUMN_MAPPING } from '../../types';

const config: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'otel_logs',
  isOtel: true,
  columns: OTEL_COLUMN_MAPPING,
};

const logAttributesContainer: FieldModel = {
  id: 'col:LogAttributes',
  name: 'LogAttributes',
  displayName: 'LogAttributes',
  sqlExpr: 'LogAttributes',
  type: 'map',
  source: 'column',
};

const resourceAttributesContainer: FieldModel = {
  id: 'col:ResourceAttributes',
  name: 'ResourceAttributes',
  displayName: 'ResourceAttributes',
  sqlExpr: 'ResourceAttributes',
  type: 'map',
  source: 'column',
};

const jsonUserId: FieldModel = {
  id: 'json:Payload:user.id',
  name: 'user.id',
  displayName: 'Payload.user.id',
  sqlExpr: `Payload."user"."id"`,
  type: 'string',
  source: 'json',
  jsonColumn: 'Payload',
  jsonPath: 'user.id',
};

const tupleA: FieldModel = {
  id: 'tuple:MyTuple:a',
  name: 'a',
  displayName: 'MyTuple.a',
  sqlExpr: `MyTuple.a`,
  type: 'string',
  source: 'tuple',
  tupleColumn: 'MyTuple',
};

describe('resolveField — Map-key fallback', () => {
  it('resolves an undiscovered <mapColumn>.<key> to the bracket accessor', () => {
    const index = buildFieldIndex([logAttributesContainer]);
    const resolved = resolveField('LogAttributes.http.method', config, index);
    expect(resolved).toEqual({ sqlExpr: "LogAttributes['http.method']", kind: 'map' });
  });

  it('quotes a key containing a single quote the same way quoteString does elsewhere', () => {
    const index = buildFieldIndex([logAttributesContainer]);
    const resolved = resolveField(`LogAttributes.it's`, config, index);
    // quoteString (queryBuilder.ts) backslash-escapes a single quote for SQL escaping.
    expect(resolved).toEqual({ sqlExpr: "LogAttributes['it\\'s']", kind: 'map' });
  });

  it('a real discovered field with the same dotted shape wins over the fallback (JSON path)', () => {
    const index = buildFieldIndex([logAttributesContainer, jsonUserId]);
    // Not "LogAttributes...", so this exercises precedence in general: a real byName/byDisplayName
    // hit for a JSON path is returned before the Map-key fallback is ever consulted.
    const resolved = resolveField('Payload.user.id', config, index);
    expect(resolved).toEqual({ sqlExpr: jsonUserId.sqlExpr, kind: 'json' });
  });

  it('a real discovered Tuple element with the same dotted shape wins over the fallback', () => {
    const index = buildFieldIndex([logAttributesContainer, tupleA]);
    const resolved = resolveField('MyTuple.a', config, index);
    expect(resolved).toEqual({ sqlExpr: tupleA.sqlExpr, kind: 'exact' });
  });

  it('explicit bracket syntax still wins over the fallback', () => {
    const index = buildFieldIndex([logAttributesContainer]);
    const resolved = resolveField(`LogAttributes['http.method']`, config, index);
    expect(resolved).toEqual({ sqlExpr: `LogAttributes['http.method']`, kind: 'map' });
  });

  it('a bare, unprefixed key still does not resolve (unchanged behavior)', () => {
    const index = buildFieldIndex([logAttributesContainer]);
    const resolved = resolveField('http.method', config, index);
    expect(resolved).toBeNull();
  });

  it('longest matching Map column wins when one container name is a prefix of another', () => {
    const shortContainer: FieldModel = {
      id: 'col:Log',
      name: 'Log',
      displayName: 'Log',
      sqlExpr: 'Log',
      type: 'map',
      source: 'column',
    };
    const index = buildFieldIndex([shortContainer, logAttributesContainer]);
    const resolved = resolveField('LogAttributes.http.method', config, index);
    expect(resolved).toEqual({ sqlExpr: "LogAttributes['http.method']", kind: 'map' });
  });

  it('resolves against the correct container when multiple Map columns are discovered', () => {
    const index = buildFieldIndex([logAttributesContainer, resourceAttributesContainer]);
    expect(resolveField('ResourceAttributes.service.name', config, index)).toEqual({
      sqlExpr: "ResourceAttributes['service.name']",
      kind: 'map',
    });
    expect(resolveField('LogAttributes.http.method', config, index)).toEqual({
      sqlExpr: "LogAttributes['http.method']",
      kind: 'map',
    });
  });

  it('without an index, the fallback never fires (matches historical no-index behavior)', () => {
    const resolved = resolveField('LogAttributes.http.method', config);
    expect(resolved).toBeNull();
  });

  it('a dotted name with nothing after the map column name does not match (needs a real key)', () => {
    const index = buildFieldIndex([logAttributesContainer]);
    expect(resolveField('LogAttributes.', config, index)).toBeNull();
  });
});
