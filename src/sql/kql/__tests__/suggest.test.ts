import { getSuggestions } from '../suggest';
import { FieldModel } from '../../fieldModel';
import { lex } from '../_lexer';

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

  // ── Map/JSON field display prefix (matches the field sidebar's grouping labels) ───────────
  it('a nested field suggestion shows the source-column-prefixed displayName, not the bare key', () => {
    const nestedFields: FieldModel[] = [
      ...fields,
      {
        id: 'map:ResourceAttributes:k8s.namespace.name',
        name: 'k8s.namespace.name',
        displayName: 'ResourceAttributes.k8s.namespace.name',
        sqlExpr: "ResourceAttributes['k8s.namespace.name']",
        type: 'string',
        source: 'map',
        mapColumn: 'ResourceAttributes',
      },
    ];
    const { suggestions } = getSuggestions('k8s', 3, nestedFields);
    const s = suggestions.find((sug) => sug.type === 'field');
    expect(s?.text).toBe('ResourceAttributes.k8s.namespace.name');
    // Insert exactly what's shown — accepting a suggestion must never rewrite what the user typed
    // (see suggest.ts's fieldSuggestions). resolveField (fields.ts) resolves this full
    // displayName directly via its byDisplayName index, including for Map fields.
    expect(s?.insertText).toBe('ResourceAttributes.k8s.namespace.name ');
  });

  it('a field name containing KQL delimiters is escaped so it re-lexes as one token', () => {
    const specialFields: FieldModel[] = [
      {
        id: 'map:LogAttributes:a:b',
        name: 'a:b',
        displayName: 'LogAttributes.a:b',
        sqlExpr: "LogAttributes['a:b']",
        type: 'string',
        source: 'map',
        mapColumn: 'LogAttributes',
      },
    ];
    const { suggestions } = getSuggestions('', 0, specialFields);
    const s = suggestions.find((sug) => sug.type === 'field');
    // Escaped as \uXXXX (see _escape.ts) rather than a bare backslash — the round-trip is what
    // matters, not the exact escape spelling, so assert it via the lexer instead of a literal.
    const tokens = lex(s!.insertText.trim()).filter((t) => t.type !== 'EOF');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].value).toBe('LogAttributes.a:b');
  });

  // ── After field + space → operators ────────────────────────────────────────
  it('after "SeverityText " → operator suggestions', () => {
    const q = 'SeverityText ';
    const { suggestions } = getSuggestions(q, q.length, fields);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every((s) => s.type === 'operator')).toBe(true);
  });

  it('operator ":" has insert-text ": "', () => {
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
    // Quoted — see 'the label matches it' test below for why (Kibana parity).
    expect(suggestions[0].text).toBe('"error"');
    expect(suggestions[0].type).toBe('value');
  });

  it('value insert-text is quoted with trailing space, and the label matches it', () => {
    const values = [{ value: 'error', count: 10 }];
    const q = 'SeverityText:';
    const { suggestions } = getSuggestions(q, q.length, fields, values);
    expect(suggestions[0].insertText).toBe('"error" ');
    // Matches Kibana: the displayed suggestion text is the exact (quoted) string that gets
    // inserted — no separate unquoted label — so accepting it never changes what was on screen.
    expect(suggestions[0].text).toBe('"error"');
  });

  it('value for a numeric field is inserted unquoted', () => {
    const numericFields: FieldModel[] = [
      { id: 'col:duration', name: 'duration', displayName: 'duration', sqlExpr: 'duration', type: 'number', source: 'column' },
    ];
    const values = [{ value: '500', count: 4 }];
    const q = 'duration:';
    const { suggestions } = getSuggestions(q, q.length, numericFields, values);
    expect(suggestions[0].insertText).toBe('500 ');
    expect(suggestions[0].text).toBe('500');
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

  it('conjunction insert-text has trailing space', () => {
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

  // ── Map dot-drilldown ───────────────────────────────────────────────────────
  describe('Map dot-drilldown', () => {
    const mapContainer: FieldModel = {
      id: 'col:LogAttributes',
      name: 'LogAttributes',
      displayName: 'LogAttributes',
      sqlExpr: 'LogAttributes',
      type: 'map',
      source: 'column',
    };
    const jsonPath: FieldModel = {
      id: 'json:Payload:LogAttributes.override',
      name: 'LogAttributes.override',
      displayName: 'Payload.LogAttributes.override',
      sqlExpr: `Payload."LogAttributes.override"`,
      type: 'string',
      source: 'json',
      jsonColumn: 'Payload',
      jsonPath: 'LogAttributes.override',
    };
    const withContainer: FieldModel[] = [...fields, mapContainer];

    it('a Map container suggestion inserts a trailing dot, not a trailing space', () => {
      const { suggestions } = getSuggestions('LogA', 4, withContainer);
      const s = suggestions.find((sug) => sug.text === 'LogAttributes.');
      expect(s).toBeDefined();
      expect(s?.type).toBe('field');
      expect(s?.insertText).toBe('LogAttributes.');
      expect(s?.description).toMatch(/browse keys/);
    });

    it('typing "LogAttributes." with no keys loaded yet returns a mapKeyContext and no key suggestions', () => {
      const q = 'LogAttributes.';
      const { suggestions, mapKeyContext } = getSuggestions(q, q.length, withContainer);
      expect(mapKeyContext).toEqual({ column: 'LogAttributes', prefix: '', replaceStart: 0, replaceEnd: q.length });
      expect(suggestions.some((s) => s.type === 'mapkey')).toBe(false);
    });

    it('"LogAttributes." with an empty key prefix also offers the whole-map escape row', () => {
      const q = 'LogAttributes.';
      const { suggestions } = getSuggestions(q, q.length, withContainer);
      const whole = suggestions.find((s) => s.text === 'LogAttributes' && s.description?.includes('whole column'));
      expect(whole).toBeDefined();
      expect(whole?.insertText).toBe('LogAttributes ');
      expect(whole?.replaceStart).toBe(0);
      expect(whole?.replaceEnd).toBe(q.length);
    });

    it('once keys are loaded, "LogAttributes." lists them as mapkey suggestions', () => {
      const q = 'LogAttributes.';
      const mapKeys = new Map([['LogAttributes', ['http.method', 'http.status_code']]]);
      const { suggestions } = getSuggestions(q, q.length, withContainer, [], mapKeys);
      const keySugg = suggestions.filter((s) => s.type === 'mapkey');
      expect(keySugg.map((s) => s.text).sort()).toEqual(['LogAttributes.http.method', 'LogAttributes.http.status_code']);
      expect(keySugg[0].insertText).toContain(' '); // trailing space, unlike the container's dot
      expect(keySugg.every((s) => s.replaceStart === 0 && s.replaceEnd === q.length)).toBe(true);
    });

    it('typing a key prefix filters the already-loaded key list locally, prefix-first ranked', () => {
      const q = 'LogAttributes.stat';
      const mapKeys = new Map([['LogAttributes', ['http.method', 'http.status_code', 'other.status']]]);
      const { suggestions, mapKeyContext } = getSuggestions(q, q.length, withContainer, [], mapKeys);
      expect(mapKeyContext?.prefix).toBe('stat');
      const keySugg = suggestions.filter((s) => s.type === 'mapkey');
      expect(keySugg.map((s) => s.text)).toEqual(['LogAttributes.http.status_code', 'LogAttributes.other.status']);
    });

    it('a JSON/other field that happens to share the dotted prefix still shows alongside mapkey suggestions', () => {
      const q = 'LogAttributes.over';
      const withBoth = [...withContainer, jsonPath];
      const { suggestions } = getSuggestions(q, q.length, withBoth, [], new Map());
      expect(suggestions.some((s) => s.type === 'field' && s.text === jsonPath.displayName)).toBe(true);
    });

    it('longest matching Map column wins when one column name is a prefix of another field name', () => {
      const shortContainer: FieldModel = {
        id: 'col:Log',
        name: 'Log',
        displayName: 'Log',
        sqlExpr: 'Log',
        type: 'map',
        source: 'column',
      };
      const both = [shortContainer, mapContainer];
      const q = 'LogAttributes.htt';
      const { mapKeyContext } = getSuggestions(q, q.length, both);
      expect(mapKeyContext?.column).toBe('LogAttributes');
      expect(mapKeyContext?.prefix).toBe('htt');
    });

    it('a non-Map column with a dotted name is unaffected (no mapKeyContext)', () => {
      const { mapKeyContext, suggestions } = getSuggestions('Bo', 2, fields);
      expect(mapKeyContext).toBeUndefined();
      expect(suggestions.some((s) => s.type === 'mapkey')).toBe(false);
    });

    // Regression: typing (or accepting a mapkey suggestion for) a full "<mapCol>.<key>:" used to
    // build a valueContext whose sqlExpr was the literal dotted string itself — fieldSqlExpr only
    // ever looked the name up in `fields`, and a Map key is never published there (it's
    // sample-scoped, see sql/keys.ts). loadValues then ran that literal string as if it were a raw
    // SQL expression — invalid ClickHouse syntax — silently swallowed into an empty value dropdown
    // with no visible error.
    it('"<mapColumn>.<key>:" builds a valueContext with the real bracket-accessor sqlExpr, not the literal dotted string', () => {
      const q = 'LogAttributes.k8s.pod.name:';
      const { valueContext } = getSuggestions(q, q.length, withContainer);
      expect(valueContext?.fieldName).toBe('LogAttributes.k8s.pod.name');
      expect(valueContext?.sqlExpr).toBe("LogAttributes['k8s.pod.name']");
    });

    it('"<mapColumn>.<key>:" resolves against the correct one of several discovered Map columns', () => {
      const resourceAttrsContainer: FieldModel = {
        id: 'col:ResourceAttributes',
        name: 'ResourceAttributes',
        displayName: 'ResourceAttributes',
        sqlExpr: 'ResourceAttributes',
        type: 'map',
        source: 'column',
      };
      const both = [...withContainer, resourceAttrsContainer];
      const q = 'ResourceAttributes.k8s.pod.name:';
      const { valueContext } = getSuggestions(q, q.length, both);
      expect(valueContext?.sqlExpr).toBe("ResourceAttributes['k8s.pod.name']");
    });

    it('typed value prefix after the key ("<mapColumn>.<key>:partial") also resolves the real sqlExpr', () => {
      const q = 'LogAttributes.k8s.pod.name:pod-';
      const { valueContext } = getSuggestions(q, q.length, withContainer);
      expect(valueContext?.fieldName).toBe('LogAttributes.k8s.pod.name');
      expect(valueContext?.sqlExpr).toBe("LogAttributes['k8s.pod.name']");
      expect(valueContext?.prefix).toBe('pod-');
    });
  });
});
