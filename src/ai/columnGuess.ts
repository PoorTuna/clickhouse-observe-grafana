/**
 * "Guess with AI" — best-effort column-mapping guesser. Sends the table's real column list
 * (name + ClickHouse type) to an OpenAI-compatible chat model and asks it to fill in a subset of
 * ColumnMapping keys, then validates the reply against ground truth before returning it.
 *
 * Deliberately does NOT use function/tool-calling or response_format:json_object — those are the
 * first things to break on weak or self-hosted models (the explicit target here, e.g. Ollama
 * running a 1-3B model). Plain "reply with only JSON" + lenient parsing + strict validation is the
 * lowest common denominator that works everywhere.
 */

import { AiProviderConfig, ColumnMapping } from '../types';
import { COL_FIELDS } from '../columnFields';
import { chatCompletion, ChatMessage } from './client';

export interface TableColumn {
  name: string;
  type: string;
}

export interface GuessColumnMappingArgs {
  table: string;
  columns: TableColumn[];
  /** Which ColumnMapping keys to ask the model to fill. */
  targets: Array<keyof ColumnMapping>;
}

// Short, role-focused hints for the AI prompt — deliberately NOT the same text as COL_FIELDS'
// label/description (those are written for a human reading the settings form, e.g. "Traces page
// only — no effect on Logs Explorer", which is irrelevant noise for the model and measurably hurt
// guess quality in testing against a weak local model). Only the fields actually useful to guess
// need an entry here; anything else falls back to COL_FIELDS' label.
const AI_ROLE_HINTS: Partial<Record<keyof ColumnMapping, string>> = {
  timestamp: 'the column holding the event date/time (a Date, DateTime, or DateTime64 typed column)',
  body: 'the main free-text log message column',
  severity: 'the log level/severity column (e.g. INFO, WARN, ERROR)',
  serviceName: 'the column naming which service/application produced the log',
  traceId: 'the distributed-tracing trace identifier column',
};

function buildPrompt(args: GuessColumnMappingArgs): ChatMessage[] {
  const { table, columns, targets } = args;

  const fieldDocs = targets
    .map((key) => {
      const field = COL_FIELDS.find((f) => f.key === key);
      const hint = AI_ROLE_HINTS[key] ?? field?.label ?? key;
      return `- "${key}": ${hint}`;
    })
    .join('\n');

  const columnList = columns.map((c) => `${c.name} (${c.type})`).join('\n');

  // Testing against a weak local model (Ollama qwen2.5:1.5b) showed two things clearly: (1) an
  // OTel few-shot example in the system prompt made the model blank out EVERY field whenever the
  // real columns didn't literally match the example — removed entirely, it was a net negative;
  // (2) tight, single-purpose rules with no extra reasoning-inviting text scored best. Keep this
  // prompt terse — every added sentence measurably increased the odds of a malformed/empty reply.
  const system = [
    'You are a precise data-mapping assistant. Given a list of database columns, map each requested ' +
      'role to the best-matching column name.',
    `Table: ${table}`,
    'Roles to map:',
    fieldDocs,
    '',
    'Rules:',
    '- Reply with ONLY a single-line JSON object, nothing else (no prose, no markdown fences).',
    '- The object must have exactly these keys: ' + targets.map((k) => `"${k}"`).join(', ') + '.',
    '- Each value is a column name copied EXACTLY from the "Columns" list below, or "" if nothing fits.',
    '- Column names may use different words, abbreviations, or casing than the role — match by meaning.',
    '- Never output a column name that is not in the "Columns" list.',
  ].join('\n');

  const user = `Columns:\n${columnList}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Parse a model's raw reply into a validated Partial<ColumnMapping>. Never throws — a model that
 * replies with garbage yields `{}` (equivalent to "guessed nothing"), which the caller treats the
 * same as any other empty result.
 */
export function parseMapping(
  raw: string,
  validColumnNames: readonly string[],
  targets: ReadonlyArray<keyof ColumnMapping>
): Partial<ColumnMapping> {
  const validNames = new Set(validColumnNames);
  const targetKeys = new Set<string>(targets);

  // Strip markdown code fences (```json ... ``` or ``` ... ```) some models wrap replies in.
  const withoutFences = raw.replace(/```(?:json)?/gi, '');

  // Extract the first {...} block — tolerates leading/trailing prose around the JSON.
  const match = withoutFences.match(/\{[\s\S]*\}/);
  if (!match) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return {};
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  const result: Partial<ColumnMapping> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!targetKeys.has(key)) {
      continue; // not a field we asked about — ignore (also drops hallucinated keys)
    }
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed === '') {
      continue; // model said "no column fits" — leave unset rather than writing ""
    }
    if (!validNames.has(trimmed)) {
      continue; // hallucination guard — model named a column that doesn't exist on this table
    }
    result[key as keyof ColumnMapping] = trimmed;
  }
  return result;
}

/** Ask the configured LLM to guess a subset of the column mapping. Best-effort: on any failure
 * (network, non-JSON reply, all-hallucinated reply) resolves to `{}` rather than throwing, so
 * callers can treat "no error" and "guessed nothing" uniformly if they choose — though callers
 * that want to surface a distinct error message to the user should catch chatCompletion's throw
 * separately (see CreateDataViewModal's onAiGuess, which does).
 *
 * Runs one repair pass for any target the first call didn't answer. Testing against a weak local
 * model (Ollama qwen2.5:1.5b) found it reliably drops arbitrary keys from a 5-key JSON reply, but
 * is much more consistent when asked for only 1-2 keys — so re-asking with a narrower target list
 * measurably recovers fields the first pass missed, at the cost of one extra round-trip only when
 * needed (never on a full first-pass hit).
 */
export async function guessColumnMapping(
  cfg: AiProviderConfig,
  args: GuessColumnMappingArgs
): Promise<Partial<ColumnMapping>> {
  const validNames = args.columns.map((c) => c.name);

  const firstRaw = await chatCompletion(cfg, buildPrompt(args));
  const result = parseMapping(firstRaw, validNames, args.targets);

  const missing = args.targets.filter((t) => !(t in result));
  if (missing.length === 0) {
    return result;
  }

  try {
    const repairRaw = await chatCompletion(cfg, buildPrompt({ ...args, targets: missing }));
    const repaired = parseMapping(repairRaw, validNames, missing);
    return { ...result, ...repaired };
  } catch {
    // Repair pass is a bonus, not a requirement — the first pass's (possibly partial) result
    // still stands on any repair failure (network hiccup, malformed reply, etc).
    return result;
  }
}
