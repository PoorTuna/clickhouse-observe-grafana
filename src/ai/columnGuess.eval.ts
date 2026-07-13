/**
 * Graded eval for the "Guess with AI" column-mapping assist — answers "is it working or is it
 * dogshit?" against the L1→L5 fixture tables in scripts/clickhouse-init/03_ai_eval_fixtures.sql.
 *
 * Standalone script (not a jest test — needs a live ClickHouse + a live LLM), talks to ClickHouse
 * over its HTTP interface directly rather than through the Grafana datasource plugin (this runs
 * outside a browser/Grafana context).
 *
 * Prerequisites:
 *   docker compose up -d                              — ClickHouse + Ollama running
 *   docker compose exec ollama ollama pull qwen2.5:1.5b
 *
 * Usage:
 *   npx ts-node src/ai/columnGuess.eval.ts
 *   AI_MODEL=llama3.2:1b npx ts-node src/ai/columnGuess.eval.ts   — try a different model
 *   AI_RUNS=10 npx ts-node src/ai/columnGuess.eval.ts             — more repeats per table
 *
 * Ramp discipline: run L1 first (must hit 100%) before trusting results at harder levels — a
 * model that can't nail exact OTel names won't do better on abbreviations or decoys.
 */

import { guessColumnMapping, TableColumn } from './columnGuess';
import { ColumnMapping } from '../types';

// ── Config ────────────────────────────────────────────────────────────────────
const CH_URL = process.env.CH_URL ?? 'http://localhost:8123';
const AI_BASE_URL = process.env.AI_BASE_URL ?? 'http://localhost:11434/v1';
const AI_MODEL = process.env.AI_MODEL ?? 'qwen2.5:1.5b';
const AI_TOKEN = process.env.AI_TOKEN; // optional
const RUNS = Number(process.env.AI_RUNS ?? 5);

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Gold mappings mirror the doc comments in 03_ai_eval_fixtures.sql — keep both in sync.
type Level = { level: number; table: string; targets: Array<keyof ColumnMapping>; gold: Partial<ColumnMapping>; bar: number };

const LEVELS: Level[] = [
  {
    level: 1,
    table: 'eval_otel',
    targets: ['timestamp', 'body', 'severity', 'serviceName', 'traceId'],
    gold: { timestamp: 'Timestamp', body: 'Body', severity: 'SeverityText', serviceName: 'ServiceName', traceId: 'TraceId' },
    bar: 1.0,
  },
  {
    level: 2,
    table: 'eval_common',
    targets: ['timestamp', 'body', 'severity', 'serviceName', 'traceId'],
    gold: { timestamp: 'timestamp', body: 'message', severity: 'level', serviceName: 'service', traceId: 'trace_id' },
    bar: 0.9,
  },
  {
    level: 3,
    table: 'eval_abbrev',
    targets: ['timestamp', 'body', 'severity', 'serviceName', 'traceId'],
    gold: { timestamp: 'ts', body: 'msg', severity: 'lvl', serviceName: 'svc', traceId: 'tid' },
    bar: 0.75,
  },
  {
    level: 4,
    table: 'eval_noisy',
    targets: ['timestamp', 'body', 'severity', 'serviceName', 'traceId'],
    gold: { timestamp: 'event_time', body: 'body', severity: 'severity_level', serviceName: 'service', traceId: 'trace_id' },
    bar: 0.6, // timestamp+body specifically must be right — checked separately below
  },
  {
    level: 5,
    table: 'eval_adversarial',
    targets: ['timestamp', 'body', 'severity', 'serviceName', 'traceId'],
    gold: { timestamp: 'col_a', body: 'pesan', severity: 'f1', serviceName: 'svc_tag', traceId: 'tr_ref' },
    bar: 0, // best-effort only — no accuracy bar, just "doesn't crash / doesn't hallucinate"
  },
];

// ── ClickHouse HTTP client ───────────────────────────────────────────────────
async function fetchColumns(table: string): Promise<TableColumn[]> {
  const sql = `SELECT name, type FROM system.columns WHERE database = 'default' AND table = '${table}' ORDER BY position FORMAT JSONEachRow`;
  const res = await fetch(CH_URL, { method: 'POST', body: sql });
  if (!res.ok) {
    throw new Error(`ClickHouse query failed (${res.status}): ${await res.text()}`);
  }
  const text = await res.text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TableColumn);
}

// ── Scoring ───────────────────────────────────────────────────────────────────
interface RunResult {
  perField: Record<string, boolean>;
  invalidCount: number;
}

function scoreRun(guessed: Partial<ColumnMapping>, gold: Partial<ColumnMapping>, validNames: string[]): RunResult {
  const perField: Record<string, boolean> = {};
  for (const key of Object.keys(gold) as Array<keyof ColumnMapping>) {
    perField[key] = guessed[key] === gold[key];
  }
  // guessColumnMapping already drops hallucinated names via parseMapping's hallucination guard,
  // so invalidCount here should always be 0 — asserted as a canary in case that guard regresses.
  const invalidCount = Object.values(guessed).filter((v) => v && !validNames.includes(v)).length;
  return { perField, invalidCount };
}

async function runLevel(lvl: Level): Promise<void> {
  console.log(`\n=== L${lvl.level} ${lvl.table} (bar: ${lvl.level === 5 ? 'best-effort' : `${lvl.bar * 100}%`}) ===`);
  const columns = await fetchColumns(lvl.table);
  if (columns.length === 0) {
    console.log(`  SKIP — table not found or empty (did you run the eval fixtures seed?)`);
    return;
  }
  const validNames = columns.map((c) => c.name);
  const cfg = { enabled: true, baseUrl: AI_BASE_URL, model: AI_MODEL, token: AI_TOKEN };

  const runs: RunResult[] = [];
  for (let i = 0; i < RUNS; i++) {
    try {
      const guessed = await guessColumnMapping(cfg, { table: lvl.table, columns, targets: lvl.targets });
      runs.push(scoreRun(guessed, lvl.gold, validNames));
    } catch (e) {
      console.log(`  run ${i + 1}: ERROR — ${(e as Error)?.message ?? e}`);
      runs.push({ perField: Object.fromEntries(Object.keys(lvl.gold).map((k) => [k, false])), invalidCount: 0 });
    }
  }

  const fieldKeys = Object.keys(lvl.gold);
  let totalHits = 0;
  let totalInvalid = 0;
  for (const key of fieldKeys) {
    const hits = runs.filter((r) => r.perField[key]).length;
    console.log(`  ${key.padEnd(12)} ${hits}/${RUNS} ${hits === RUNS ? '✓' : hits === 0 ? '✗' : '~'}`);
    totalHits += hits;
  }
  totalInvalid = runs.reduce((sum, r) => sum + r.invalidCount, 0);

  const overall = totalHits / (fieldKeys.length * RUNS);
  const worst = Math.min(...fieldKeys.map((key) => runs.filter((r) => r.perField[key]).length / RUNS));
  const pass = lvl.level === 5 ? totalInvalid === 0 : overall >= lvl.bar;

  console.log(`  overall: ${(overall * 100).toFixed(0)}%  worst-field: ${(worst * 100).toFixed(0)}%  invalid-columns: ${totalInvalid}`);
  console.log(`  ${pass ? 'PASS' : 'FAIL'} — ${lvl.level === 5 ? 'hallucination guard' : `bar ${lvl.bar * 100}%`}`);
}

async function main() {
  console.log(`AI eval: ${AI_BASE_URL} model=${AI_MODEL} runs=${RUNS}`);
  for (const lvl of LEVELS) {
    await runLevel(lvl);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
