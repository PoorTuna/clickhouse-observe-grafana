/**
 * KQL parse-error type + formatter, styled after Kibana's KQLSyntaxError:
 * https://github.com/elastic/kibana/blob/main/src/platform/packages/shared/kbn-es-query/src/kuery/kuery_syntax_error.ts
 *
 * A parse failure blocks the search (see SearchBar.commit()) rather than silently falling back
 * to a plain-text search — same as Kibana, which never sends a query it couldn't parse.
 */

/** One human-readable line: "Expected {expected} but {found} found." plus a caret pointing at
 *  the offending character, e.g.:
 *
 *    Expected end of input but ":" found.
 *    level:error service:pay
 *    --------------------^
 */
export class KqlSyntaxError extends Error {
  readonly expected: string[];
  readonly found: string | null;
  readonly position: number;

  constructor(expected: string[], found: string | null, position: number, input: string) {
    super(formatMessage(expected, found, position, input));
    this.name = 'KqlSyntaxError';
    this.expected = expected;
    this.found = found;
    this.position = position;
  }
}

function formatMessage(expected: string[], found: string | null, position: number, input: string): string {
  const expectedText = expected.length > 0 ? expected.join(' or ') : 'end of input';
  const foundText = found === null ? 'end of input' : JSON.stringify(found);
  const caret = '-'.repeat(Math.max(0, position)) + '^';
  return `Expected ${expectedText} but ${foundText} found.\n${input}\n${caret}`;
}
