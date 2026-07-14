/**
 * Unit tests for Tuple-column support: inferFieldType's 'tuple' branch and parseTupleElements,
 * which flatten a Tuple(...) column into individually addressable fields (see FieldsContext.tsx's
 * Phase D, which uses this to mirror Map-key / JSON-path discovery for tuples).
 */

import { inferFieldType, parseTupleElements } from '../fieldModel';

describe('inferFieldType — Tuple', () => {
  it('infers a plain named tuple as "tuple"', () => {
    expect(inferFieldType('Tuple(a String, b Int64)')).toBe('tuple');
  });

  it('infers an unnamed tuple as "tuple"', () => {
    expect(inferFieldType('Tuple(String, Int64)')).toBe('tuple');
  });

  it('does not misclassify unrelated types as tuple', () => {
    expect(inferFieldType('String')).not.toBe('tuple');
    expect(inferFieldType('Map(String, String)')).not.toBe('tuple');
    expect(inferFieldType('Array(String)')).not.toBe('tuple');
  });
});

describe('inferFieldType — Array (incl. ClickHouse Nested-flattened columns)', () => {
  it('infers a plain Array(...) column as "array"', () => {
    expect(inferFieldType('Array(String)')).toBe('array');
  });

  it('infers a Nested-flattened dotted column as "array", not "unknown"', () => {
    // ClickHouse flattens `Nested(a String, b Int64)` named `N` into two system.columns rows
    // ("N.a", "Array(String)") and ("N.b", "Array(Int64)") — these already reach Phase A as
    // ordinary columns; before the Array(...) branch existed they fell through to 'unknown'.
    expect(inferFieldType('Array(String)')).toBe('array');
    expect(inferFieldType('Array(Int64)')).toBe('array');
  });

  it('infers Array(Tuple(...)) (array-of-tuples) as "array", not descending into the tuple', () => {
    expect(inferFieldType('Array(Tuple(a String, b Int64))')).toBe('array');
  });
});

describe('parseTupleElements', () => {
  it('parses a named tuple', () => {
    expect(parseTupleElements('Tuple(a String, b Int64)')).toEqual([
      { name: 'a', type: 'String' },
      { name: 'b', type: 'Int64' },
    ]);
  });

  it('parses an unnamed tuple with positional names matching CH dot-access (1-indexed)', () => {
    expect(parseTupleElements('Tuple(String, Int64)')).toEqual([
      { name: '1', type: 'String' },
      { name: '2', type: 'Int64' },
    ]);
  });

  it('handles mixed named/unnamed elements per-element', () => {
    expect(parseTupleElements('Tuple(a String, Int64)')).toEqual([
      { name: 'a', type: 'String' },
      { name: '2', type: 'Int64' },
    ]);
  });

  it('splits only on top-level commas — an element type with its own commas is not broken apart', () => {
    expect(parseTupleElements('Tuple(a Decimal(10, 2), b String)')).toEqual([
      { name: 'a', type: 'Decimal(10, 2)' },
      { name: 'b', type: 'String' },
    ]);
  });

  it('recurses through a nested Tuple element, producing dotted leaf names', () => {
    expect(parseTupleElements('Tuple(a Tuple(x Int64, y Int64), b String)')).toEqual([
      { name: 'a.x', type: 'Int64' },
      { name: 'a.y', type: 'Int64' },
      { name: 'b', type: 'String' },
    ]);
  });

  it('recurses through multiple levels of nested Tuples', () => {
    expect(parseTupleElements('Tuple(a Tuple(b Tuple(c Int64)))')).toEqual([
      { name: 'a.b.c', type: 'Int64' },
    ]);
  });

  it('keeps a Map element type as one raw string — recursion is Tuple-into-Tuple only', () => {
    expect(parseTupleElements('Tuple(a Map(String, String), b String)')).toEqual([
      { name: 'a', type: 'Map(String, String)' },
      { name: 'b', type: 'String' },
    ]);
  });

  it('keeps an Array(Tuple(...)) element as one raw string — arrays are not expanded', () => {
    expect(parseTupleElements('Tuple(a Array(Tuple(x Int64)), b String)')).toEqual([
      { name: 'a', type: 'Array(Tuple(x Int64))' },
      { name: 'b', type: 'String' },
    ]);
  });

  it('returns an empty array for a non-Tuple type string', () => {
    expect(parseTupleElements('String')).toEqual([]);
    expect(parseTupleElements('Map(String, String)')).toEqual([]);
  });

  it('returns an empty array for a Tuple with no elements (defensive — not real CH syntax)', () => {
    expect(parseTupleElements('Tuple()')).toEqual([]);
  });
});
