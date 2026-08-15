import { labelForKind, tooltipForKind } from '../phaseColors';

describe('labelForKind', () => {
  it('translates every QueryOp to a plain-language label, not the raw op string', () => {
    expect(labelForKind('jsonPaths', 'jsonPaths')).toBe('JSON path discovery');
    expect(labelForKind('traceLink', 'traceLink')).toBe('Trace link lookup');
    expect(labelForKind('logs', 'logs')).toBe('Log rows');
  });

  // The 'columns' query op (sidebar field-list discovery) and the 'Columns' group action name
  // (LogsExplorer.tsx's describeGroupChange, a grid column edit) are different things that happen
  // to share a word — the op label must not collide with the action name.
  it('disambiguates the "columns" query op from the "Columns" group action name', () => {
    expect(labelForKind('columns', 'columns')).toBe('Column discovery');
    expect(labelForKind('columns', 'columns')).not.toBe('Columns');
  });

  it('falls through to the span name for an action root (already plain language)', () => {
    expect(labelForKind('action', 'Search')).toBe('Search');
    expect(labelForKind('action', 'Time range')).toBe('Time range');
  });

  it('still labels phase kinds (unaffected by the query-op label addition)', () => {
    expect(labelForKind('decode', 'decode')).toBe('decode (parse response)');
  });
});

describe('tooltipForKind', () => {
  it('gives every QueryOp a tooltip explaining what it is for', () => {
    expect(tooltipForKind('presence', 'presence')).toMatch(/available vs empty/i);
    expect(tooltipForKind('fieldValues', 'fieldValues')).toMatch(/autocomplete/i);
  });
});
