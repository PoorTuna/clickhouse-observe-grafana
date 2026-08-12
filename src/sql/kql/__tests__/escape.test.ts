import { escapeKqlIdent } from '../_escape';
import { lex } from '../_lexer';

/** Escaping only matters if the lexer folds it back into the original value as one IDENT token —
 *  otherwise autocomplete would insert text that immediately re-splits on the next keystroke. */
function roundTrips(raw: string) {
  const escaped = escapeKqlIdent(raw);
  const tokens = lex(escaped).filter((t) => t.type !== 'EOF');
  expect(tokens).toHaveLength(1);
  expect(tokens[0].type).toBe('IDENT');
  expect(tokens[0].value).toBe(raw);
}

describe('escapeKqlIdent', () => {
  it('leaves a plain dotted name untouched', () => {
    expect(escapeKqlIdent('ResourceAttributes.k8s.namespace.name')).toBe('ResourceAttributes.k8s.namespace.name');
    roundTrips('ResourceAttributes.k8s.namespace.name');
  });

  it.each([
    'a b',        // space
    'a:b',        // colon (operator delimiter)
    'a(b)',       // parens
    'a*b',        // wildcard sentinel char
    'a\\b',       // literal backslash
    'a"b',        // quote
    'a<b>c',      // angle brackets
  ])('round-trips %j through the lexer as one IDENT', (raw) => {
    roundTrips(raw);
  });

  it('escapes a bare "and"/"or"/"not" so it is not classified as a keyword', () => {
    for (const kw of ['and', 'or', 'not', 'AND', 'Or', 'NOT']) {
      roundTrips(kw);
    }
  });
});
