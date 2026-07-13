/**
 * Pure unit tests for parseMapping — the validation layer between a raw LLM reply and a
 * ColumnMapping the app will actually apply. No live LLM/network involved (see columnGuess.eval.ts
 * for the graded, live-model eval). These pin the parsing/validation behavior regardless of how
 * good or bad any given model is: markdown-fence stripping, junk-around-JSON tolerance, and —
 * most importantly — the hallucination guard that drops any column name the model invents.
 */

import { parseMapping } from '../columnGuess';
import { ColumnMapping } from '../../types';

const VALID_COLUMNS = ['Timestamp', 'Body', 'SeverityText', 'ServiceName', 'TraceId'];
const TARGETS: Array<keyof ColumnMapping> = ['timestamp', 'body', 'severity', 'serviceName', 'traceId'];

describe('parseMapping', () => {
  it('parses a clean JSON object', () => {
    const raw = '{"timestamp": "Timestamp", "body": "Body"}';
    expect(parseMapping(raw, VALID_COLUMNS, TARGETS)).toEqual({ timestamp: 'Timestamp', body: 'Body' });
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n{"timestamp": "Timestamp", "body": "Body"}\n```';
    expect(parseMapping(raw, VALID_COLUMNS, TARGETS)).toEqual({ timestamp: 'Timestamp', body: 'Body' });
  });

  it('extracts JSON surrounded by prose', () => {
    const raw = 'Sure! Here is the mapping:\n{"timestamp": "Timestamp"}\nHope that helps!';
    expect(parseMapping(raw, VALID_COLUMNS, TARGETS)).toEqual({ timestamp: 'Timestamp' });
  });

  it('drops hallucinated column names not in the valid list', () => {
    const raw = '{"timestamp": "Timestamp", "body": "SomeColumnThatDoesNotExist"}';
    expect(parseMapping(raw, VALID_COLUMNS, TARGETS)).toEqual({ timestamp: 'Timestamp' });
  });

  it('drops keys that are not in the target set', () => {
    const raw = '{"timestamp": "Timestamp", "notARealField": "Body"}';
    expect(parseMapping(raw, VALID_COLUMNS, TARGETS)).toEqual({ timestamp: 'Timestamp' });
  });

  it('treats empty-string values as "no guess" rather than clearing the field', () => {
    const raw = '{"timestamp": "Timestamp", "traceId": ""}';
    expect(parseMapping(raw, VALID_COLUMNS, TARGETS)).toEqual({ timestamp: 'Timestamp' });
  });

  it('ignores non-string values', () => {
    const raw = '{"timestamp": "Timestamp", "body": 123, "severity": null}';
    expect(parseMapping(raw, VALID_COLUMNS, TARGETS)).toEqual({ timestamp: 'Timestamp' });
  });

  it('returns {} for total garbage', () => {
    expect(parseMapping('not json at all', VALID_COLUMNS, TARGETS)).toEqual({});
  });

  it('returns {} for an empty string', () => {
    expect(parseMapping('', VALID_COLUMNS, TARGETS)).toEqual({});
  });

  it('returns {} when the JSON is an array, not an object', () => {
    expect(parseMapping('["Timestamp", "Body"]', VALID_COLUMNS, TARGETS)).toEqual({});
  });

  it('returns {} for malformed JSON inside braces', () => {
    expect(parseMapping('{timestamp: Timestamp, body: Body}', VALID_COLUMNS, TARGETS)).toEqual({});
  });

  it('trims whitespace around values before validating', () => {
    const raw = '{"timestamp": "  Timestamp  "}';
    expect(parseMapping(raw, VALID_COLUMNS, TARGETS)).toEqual({ timestamp: 'Timestamp' });
  });
});
