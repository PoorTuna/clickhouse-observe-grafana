/**
 * KQL tokenizer. Produces tokens with source positions for autocomplete.
 *
 * Delimiter set (characters that end an unquoted token):
 *   whitespace, (, ), {, }, :, <, >, "
 * Everything else (including ., [, ], ', -, _, /) is part of an IDENT.
 * Keywords and, or, not are emitted as AND/OR/NOT only when they form an
 * entire token with no escape sequences — so "android" stays IDENT,
 * "and" becomes AND, but "\and" stays IDENT.
 *
 * Wildcard handling:
 *   Unescaped * is replaced with a private-use-area sentinel char (WILDCARD_STAR) in the
 *   IDENT value so that downstream code can distinguish it from an escaped \* (which becomes
 *   a literal *). `?` is an ordinary character — real KQL supports only `*` as a wildcard.
 */

export type TokType =
  | 'IDENT'   // field names, unquoted values, wildcards like "pay*"
  | 'QUOTED'  // "double-quoted phrase"
  | 'LPAREN'  // (
  | 'RPAREN'  // )
  | 'LBRACE'  // {  (nested query syntax — not translated to SQL, just parsed)
  | 'RBRACE'  // }
  | 'COLON'   // :
  | 'GT'      // >
  | 'GTE'     // >=
  | 'LT'      // <
  | 'LTE'     // <=
  | 'AND'     // and / AND
  | 'OR'      // or  / OR
  | 'NOT'     // not / NOT
  | 'EOF';

export interface Token {
  type: TokType;
  value: string;
  /** Byte offset of the first character in the original input string. */
  start: number;
  /** Byte offset one past the last character. */
  end: number;
}

/**
 * Private-use-area sentinel for an unescaped `*` wildcard in an IDENT token.
 * Constructed at runtime to avoid embedding invisible chars in source.
 * Downstream: wildcardLike() converts this to the ILIKE `%` metacharacter.
 * Escaped `\*` becomes a literal `*` with no sentinel.
 */
export const WILDCARD_STAR  = String.fromCharCode(0xE000);

/** Matches the wildcard sentinel — used by the parser to set isWildcard. */
export const WILDCARD_RE = new RegExp('[' + WILDCARD_STAR + ']');

const DELIMITERS = /[\s(){}<>:"]/;

export function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i])) {
      i++;
      continue;
    }

    const start = i;

    // Double-quoted string
    if (input[i] === '"') {
      i++;
      let value = '';
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = readEscape(input, i + 1);
          value += esc.text;
          i = esc.nextIndex;
        } else {
          value += input[i];
          i++;
        }
      }
      if (i < input.length) {
        i++; // consume closing "
      }
      tokens.push({ type: 'QUOTED', value, start, end: i });
      continue;
    }

    // Single-character punctuation
    if (input[i] === '(') { tokens.push({ type: 'LPAREN', value: '(', start, end: ++i }); continue; }
    if (input[i] === ')') { tokens.push({ type: 'RPAREN', value: ')', start, end: ++i }); continue; }
    if (input[i] === '{') { tokens.push({ type: 'LBRACE', value: '{', start, end: ++i }); continue; }
    if (input[i] === '}') { tokens.push({ type: 'RBRACE', value: '}', start, end: ++i }); continue; }
    if (input[i] === ':') { tokens.push({ type: 'COLON', value: ':', start, end: ++i }); continue; }

    // Range operators (two-char must be checked before single-char)
    if (input[i] === '>') {
      if (input[i + 1] === '=') {
        i += 2;
        tokens.push({ type: 'GTE', value: '>=', start, end: i });
      } else {
        tokens.push({ type: 'GT', value: '>', start, end: ++i });
      }
      continue;
    }
    if (input[i] === '<') {
      if (input[i + 1] === '=') {
        i += 2;
        tokens.push({ type: 'LTE', value: '<=', start, end: i });
      } else {
        tokens.push({ type: 'LT', value: '<', start, end: ++i });
      }
      continue;
    }

    // Identifier / keyword / unquoted value (including wildcards)
    let value = '';
    let hadEscape = false;
    while (i < input.length && !DELIMITERS.test(input[i])) {
      if (input[i] === '\\' && i + 1 < input.length) {
        // Escaped character: consume backslash and treat the next char literally.
        // \* becomes literal * (no sentinel = not a wildcard).
        // \and becomes literal "and" (hadEscape suppresses keyword classification).
        hadEscape = true;
        const esc = readEscape(input, i + 1);
        value += esc.text;
        i = esc.nextIndex;
      } else if (input[i] === '*') {
        // Unescaped * → wildcard sentinel so downstream can distinguish from literal *.
        value += WILDCARD_STAR;
        i++;
      } else {
        value += input[i];
        i++;
      }
    }

    if (value === '') {
      // Unknown single character — skip defensively.
      i++;
      continue;
    }

    // Only classify as keyword when the token contained no escape sequences.
    // This ensures \and / \or / \not stay IDENT tokens instead of operators.
    if (!hadEscape) {
      const lower = value.toLowerCase();
      if (lower === 'and') { tokens.push({ type: 'AND', value, start, end: i }); continue; }
      if (lower === 'or')  { tokens.push({ type: 'OR',  value, start, end: i }); continue; }
      if (lower === 'not') { tokens.push({ type: 'NOT', value, start, end: i }); continue; }
    }

    tokens.push({ type: 'IDENT', value, start, end: i });
  }

  tokens.push({ type: 'EOF', value: '', start: i, end: i });
  return tokens;
}

/**
 * Read one escape sequence starting at `at` (the character right after the backslash).
 * Handles \t \r \n, \uXXXX (4 hex digits, per the KQL grammar's EscapedUnicodeSequence), and
 * falls back to treating the character literally (\* \? \\ \: etc — any single char).
 * A malformed \u (not followed by 4 hex digits) falls back to literal 'u' + whatever follows,
 * consuming just the 'u' — same as any other single-char escape.
 */
function readEscape(input: string, at: number): { text: string; nextIndex: number } {
  const ch = input[at];
  if (ch === 'u' && /^[0-9a-fA-F]{4}$/.test(input.slice(at + 1, at + 5))) {
    const code = parseInt(input.slice(at + 1, at + 5), 16);
    return { text: String.fromCharCode(code), nextIndex: at + 5 };
  }
  switch (ch) {
    case 't':  return { text: '\t', nextIndex: at + 1 };
    case 'r':  return { text: '\r', nextIndex: at + 1 };
    case 'n':  return { text: '\n', nextIndex: at + 1 };
    default:   return { text: ch,   nextIndex: at + 1 };
  }
}
