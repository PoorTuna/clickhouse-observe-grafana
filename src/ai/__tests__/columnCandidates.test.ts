/**
 * Unit tests for expandColumnCandidates — the layer that turns raw system.columns rows into the
 * dotted-leaf candidate list guessColumnMapping/parseMapping (columnGuess.ts) and the manual
 * mapping dropdowns (CreateDataViewModal) actually offer. See the module doc comment for the
 * per-type rules (Tuple/JSON expanded + container dropped, Map left alone, everything else
 * passed through).
 */

import { expandColumnCandidates } from '../columnCandidates';
import { TableColumn } from '../columnGuess';

describe('expandColumnCandidates — Tuple', () => {
  it('expands a named tuple into dotted leaves and drops the container', () => {
    const cols: TableColumn[] = [{ name: 'trace', type: 'Tuple(id String, span_id String)' }];
    expect(expandColumnCandidates(cols)).toEqual([
      { name: 'trace.id', type: 'String' },
      { name: 'trace.span_id', type: 'String' },
    ]);
  });

  it('expands a nested tuple into fully dotted leaves', () => {
    const cols: TableColumn[] = [
      { name: 'a', type: 'Tuple(x Tuple(y Int64, z Int64), w String)' },
    ];
    expect(expandColumnCandidates(cols)).toEqual([
      { name: 'a.x.y', type: 'Int64' },
      { name: 'a.x.z', type: 'Int64' },
      { name: 'a.w', type: 'String' },
    ]);
  });

  it('expands an unnamed tuple using positional names', () => {
    const cols: TableColumn[] = [{ name: 't', type: 'Tuple(String, Int64)' }];
    expect(expandColumnCandidates(cols)).toEqual([
      { name: 't.1', type: 'String' },
      { name: 't.2', type: 'Int64' },
    ]);
  });

  it('preserves surrounding column order', () => {
    const cols: TableColumn[] = [
      { name: 'Timestamp', type: 'DateTime64(9)' },
      { name: 'service', type: 'Tuple(name String)' },
      { name: 'Body', type: 'String' },
    ];
    expect(expandColumnCandidates(cols).map((c) => c.name)).toEqual([
      'Timestamp',
      'service.name',
      'Body',
    ]);
  });
});

describe('expandColumnCandidates — JSON', () => {
  it('expands a JSON column into dotted paths and drops the container when paths are given', () => {
    const cols: TableColumn[] = [{ name: 'resource', type: 'JSON' }];
    const result = expandColumnCandidates(cols, {
      resource: [
        { path: 'user.id', chType: 'String' },
        { path: 'k8s.namespace', chType: 'String' },
      ],
    });
    expect(result).toEqual([
      { name: 'resource.user.id', type: 'String' },
      { name: 'resource.k8s.namespace', type: 'String' },
    ]);
  });

  it('dedupes repeated paths, first-seen type wins', () => {
    const cols: TableColumn[] = [{ name: 'resource', type: 'JSON' }];
    const result = expandColumnCandidates(cols, {
      resource: [
        { path: 'user.id', chType: 'String' },
        { path: 'user.id', chType: 'Int64' },
      ],
    });
    expect(result).toEqual([{ name: 'resource.user.id', type: 'String' }]);
  });

  it('keeps the JSON container when no paths were discovered (not-yet-scanned or empty)', () => {
    const cols: TableColumn[] = [{ name: 'resource', type: 'JSON' }];
    expect(expandColumnCandidates(cols)).toEqual(cols);
    expect(expandColumnCandidates(cols, { resource: [] })).toEqual(cols);
  });
});

describe('expandColumnCandidates — Map, scalars, Nested, Array', () => {
  it('leaves Map columns untouched', () => {
    const cols: TableColumn[] = [{ name: 'LogAttributes', type: 'Map(String, String)' }];
    expect(expandColumnCandidates(cols)).toEqual(cols);
  });

  it('passes through plain scalar columns unchanged', () => {
    const cols: TableColumn[] = [
      { name: 'Timestamp', type: 'DateTime64(9)' },
      { name: 'Body', type: 'String' },
      { name: 'SeverityText', type: 'LowCardinality(String)' },
    ];
    expect(expandColumnCandidates(cols)).toEqual(cols);
  });

  it('passes through already-flattened ClickHouse Nested(...) dotted rows unchanged', () => {
    const cols: TableColumn[] = [
      { name: 'N.a', type: 'Array(String)' },
      { name: 'N.b', type: 'Array(Int64)' },
    ];
    expect(expandColumnCandidates(cols)).toEqual(cols);
  });

  it('passes through Array(Tuple(...)) as a leaf, not descended into', () => {
    const cols: TableColumn[] = [{ name: 'events', type: 'Array(Tuple(a String, b Int64))' }];
    expect(expandColumnCandidates(cols)).toEqual(cols);
  });
});
