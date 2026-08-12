/**
 * Escape a raw field/value string so it round-trips through the KQL lexer (`_lexer.ts`) as a
 * single token — used when inserting autocomplete text so what the dropdown shows is exactly
 * what lands in the search bar (see suggest.ts's fieldSuggestions).
 *
 * Modeled on Kibana's escapeKuery (kbn-es-query/src/kuery/utils/escape_kuery.ts), adapted to our
 * lexer's own delimiter set instead of Elasticsearch KQL's: `_lexer.ts`'s DELIMITERS is
 * `/[\s(){}<>:"]/`, plus `*` (wildcard sentinel) and `\` (escape char) both need escaping too.
 */

const SPECIAL_CHARS = /[\s\\(){}<>:"*]/g;
const KEYWORDS = /^(and|or|not)$/i;

/** \uXXXX-escape one character — readEscape (_lexer.ts) decodes this back to the exact original
 *  character no matter what it is, unlike a bare `\` + char (which collides with the lexer's own
 *  \t/\r/\n shorthand — e.g. naively backslash-escaping the 'n' in "not" would decode back as a
 *  newline, not the letter 'n'). Using \u for every escape sidesteps that class of bug entirely. */
function uEscape(ch: string): string {
  return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
}

export function escapeKqlIdent(raw: string): string {
  let out = raw.replace(SPECIAL_CHARS, (ch) => uEscape(ch));
  // A bare "and" / "or" / "not" would otherwise lex as a keyword token, not an IDENT — escape
  // just the first character so `hadEscape` suppresses keyword classification (see _lexer.ts).
  if (KEYWORDS.test(raw)) {
    out = uEscape(out[0]) + out.slice(1);
  }
  return out;
}
