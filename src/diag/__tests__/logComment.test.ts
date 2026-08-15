import { appendLogComment, buildLogCommentTag, logCommentPrefixForTrace } from '../logComment';

describe('buildLogCommentTag / logCommentPrefixForTrace', () => {
  it('builds a pipe-delimited tag', () => {
    expect(buildLogCommentTag('trace-1', 'span-2', 'logs')).toBe('chobs|trace-1|span-2|logs');
  });

  it('the trace prefix is a strict prefix of every tag sharing that trace', () => {
    const tag = buildLogCommentTag('trace-1', 'span-2', 'logs');
    expect(tag.startsWith(logCommentPrefixForTrace('trace-1'))).toBe(true);
  });

  it('the trace prefix does not falsely match a different trace sharing a numeric prefix', () => {
    // trace-1 must not match trace-10's rows via a naive substring check.
    const tag10 = buildLogCommentTag('trace-10', 'span-1', 'logs');
    expect(tag10.startsWith(logCommentPrefixForTrace('trace-1'))).toBe(false);
  });
});

describe('appendLogComment', () => {
  it('appends to an existing trailing SETTINGS clause', () => {
    const sql = "SELECT 1\nSETTINGS max_execution_time = 10, timeout_overflow_mode = 'throw'";
    const result = appendLogComment(sql, 'chobs|t|s|logs');
    expect(result).toBe(
      "SELECT 1\nSETTINGS max_execution_time = 10, timeout_overflow_mode = 'throw', log_comment = 'chobs|t|s|logs'"
    );
    expect(result.match(/SETTINGS/gi)?.length).toBe(1);
  });

  it('adds a new SETTINGS clause when the query has none (e.g. raw SQL mode)', () => {
    const result = appendLogComment('SELECT 1 FROM t', 'chobs|t|s|logs');
    expect(result).toBe("SELECT 1 FROM t\nSETTINGS log_comment = 'chobs|t|s|logs'");
  });

  it('does not treat "SETTINGS" appearing mid-query (not on the last line) as a trailing clause', () => {
    // A pathological but possible raw-SQL case: the word appears in a comment, not as a real clause.
    const sql = "SELECT 1 -- mentions SETTINGS here\nFROM t";
    const result = appendLogComment(sql, 'chobs|t|s|logs');
    expect(result).toBe("SELECT 1 -- mentions SETTINGS here\nFROM t\nSETTINGS log_comment = 'chobs|t|s|logs'");
  });

  it('strips a single trailing semicolon before appending', () => {
    const result = appendLogComment('SELECT 1 FROM t;', 'chobs|t|s|logs');
    expect(result).toBe("SELECT 1 FROM t\nSETTINGS log_comment = 'chobs|t|s|logs'");
  });

  // Regression (B9): a raw-SQL-mode query with a SETTINGS clause wrapped across multiple lines
  // (continuation-indented past the SETTINGS keyword, not starting on the query's last line) would
  // previously get a SECOND `SETTINGS` clause appended — a ClickHouse syntax error. Skipping the
  // tag for this one query is the safe outcome, not a crash or invalid SQL.
  it('skips tagging (returns sql unchanged) when an existing SETTINGS clause spans multiple lines', () => {
    const sql = "SELECT 1\nSETTINGS max_execution_time = 10,\n  timeout_overflow_mode = 'throw'";
    expect(appendLogComment(sql, 'chobs|t|s|logs')).toBe(sql);
  });

  it('escapes single quotes and backslashes in the tag', () => {
    const result = appendLogComment('SELECT 1', "chobs|t|s|logs");
    expect(result).toContain("log_comment = 'chobs|t|s|logs'");
    // Sanity check the escaping logic itself against a value that needs it, even though real tags
    // never contain these characters (see logComment.ts's doc comment).
    const escaped = appendLogComment('SELECT 1', `it's a "test" \\ value`);
    expect(escaped).toContain(`log_comment = 'it\\'s a "test" \\\\ value'`);
  });
});
