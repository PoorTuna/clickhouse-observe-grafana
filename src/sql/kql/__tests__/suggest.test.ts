import { getSuggestions } from '../suggest';
import { FieldModel } from '../../fieldModel';

const fields: FieldModel[] = [
  { id: 'col:severity', name: 'SeverityText', displayName: 'SeverityText', sqlExpr: 'SeverityText', type: 'string', source: 'column' },
  { id: 'col:body',     name: 'Body',         displayName: 'Body',         sqlExpr: 'Body',         type: 'string', source: 'column' },
  { id: 'map:http.method', name: 'http.method', displayName: 'http.method', sqlExpr: "LogAttributes['http.method']", type: 'string', source: 'map', mapColumn: 'LogAttributes' },
  { id: 'map:service',  name: 'service',       displayName: 'service',      sqlExpr: "ResourceAttributes['service.name']", type: 'string', source: 'map', mapColumn: 'ResourceAttributes' },
];

describe('getSuggestions', () => {
  // ── Empty query ────────────────────────────────────────────────────────────
  it('empty query → not suggestion + all field suggestions', () => {
    const { suggestions } = getSuggestions('', 0, fields);
    expect(suggestions.length).toBe(fields.length + 1);
    expect(suggestions[0]).toMatchObject({ type: 'conjunction', text: 'not' });
    expect(suggestions.slice(1).every((s) => s.type === 'field')).toBe(true);
  });

  // ── Partial field name ─────────────────────────────────────────────────────
  it('partial field → filtered field suggestions', () => {
    const { suggestions } = getSuggestions('Sev', 3, fields);
    expect(suggestions.length).toBe(1);
    expect(suggestions[0].text).toBe('SeverityText');
    expect(suggestions[0].type).toBe('field');
  });

  it('field suggestion insert-text has trailing space', () => {
    const { suggestions } = getSuggestions('Bo', 2, fields);
    const s = suggestions.find((s) => s.text === 'Body');
    expect(s?.insertText).toBe('Body ');
  });

  it('field replaceStart/End covers the partial token', () => {
    const { suggestions } = getSuggestions('Bo', 2, fields);
    const s = suggestions.find((s) => s.text === 'Body');
    expect(s?.replaceStart).toBe(0);
    expect(s?.replaceEnd).toBe(2);
  });

  // ── After field + space → operators ────────────────────────────────────────
  it('after "SeverityText " → operator suggestions', () => {
    const q = 'SeverityText ';
    const { suggestions } = getSuggestions(q, q.length, fields);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every((s) => s.type === 'operator')).toBe(true);
  });

  it('operator ":" has Kibana insert-text ": "', () => {
    const q = 'Body ';
    const { suggestions } = getSuggestions(q, q.length, fields);
    const colon = suggestions.find((s) => s.text === ':');
    expect(colon?.insertText).toBe(': ');
  });

  it('operator ":*" has insert-text ":* "', () => {
    const q = 'Body ';
    const { suggestions } = getSuggestions(q, q.length, fields);
    const exists = suggestions.find((s) => s.text === ':*');
    expect(exists?.insertText).toBe(':* ');
  });

  // ── After colon → value context ───────────────────────────────────────────
  it('after "field:" → valueContext exposed', () => {
    const q = 'SeverityText:';
    const { valueContext } = getSuggestions(q, q.length, fields);
    expect(valueContext?.fieldName).toBe('SeverityText');
    expect(valueContext?.prefix).toBe('');
  });

  it('value suggestions injected + filtered by prefix', () => {
    const values = [
      { value: 'error', count: 10 },
      { value: 'warn',  count: 5  },
      { value: 'info',  count: 3  },
    ];
    const q = 'SeverityText:er';
    const { suggestions } = getSuggestions(q, q.length, fields, values);
    expect(suggestions.length).toBe(1);
    expect(suggestions[0].text).toBe('error');
    expect(suggestions[0].type).toBe('value');
  });

  it('value insert-text is quoted with trailing space (Kibana-exact)', () => {
    const values = [{ value: 'error', count: 10 }];
    const q = 'SeverityText:';
    const { suggestions } = getSuggestions(q, q.length, fields, values);
    expect(suggestions[0].insertText).toBe('"error" ');
  });

  it('value replaceStart covers partial typed value', () => {
    const values = [{ value: 'error', count: 10 }];
    const q = 'SeverityText:er';
    const { suggestions } = getSuggestions(q, q.length, fields, values);
    // "er" starts at position 13
    expect(suggestions[0].replaceStart).toBe(13);
    expect(suggestions[0].replaceEnd).toBe(15);
  });

  // ── After completed value + space → conjunctions ───────────────────────────
  it('after "level:error " → conjunction suggestions', () => {
    const q = 'SeverityText:error ';
    const { suggestions } = getSuggestions(q, q.length, fields);
    expect(suggestions.every((s) => s.type === 'conjunction')).toBe(true);
    const texts = suggestions.map((s) => s.text);
    expect(texts).toContain('and');
    expect(texts).toContain('or');
  });

  it('conjunction insert-text has trailing space (Kibana-exact)', () => {
    const q = 'SeverityText:error ';
    const { suggestions } = getSuggestions(q, q.length, fields);
    const and = suggestions.find((s) => s.text === 'and');
    expect(and?.insertText).toBe('and ');
  });

  // ── After conjunction → field suggestions ─────────────────────────────────
  it('after "level:error and " → not + field suggestions', () => {
    const q = 'SeverityText:error and ';
    const { suggestions } = getSuggestions(q, q.length, fields);
    expect(suggestions[0]).toMatchObject({ type: 'conjunction', text: 'not' });
    expect(suggestions.slice(1).every((s) => s.type === 'field')).toBe(true);
  });

  it('after "level:error and se" → field suggestions filtered by "se"', () => {
    const q = 'SeverityText:error and se';
    const { suggestions } = getSuggestions(q, q.length, fields);
    expect(suggestions.every((s) => s.type === 'field')).toBe(true);
    expect(suggestions.every((s) => s.text.toLowerCase().includes('se'))).toBe(true);
  });
});
