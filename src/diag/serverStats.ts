/**
 * Reads real ClickHouse execution stats back out of `system.query_log` for one action's queries,
 * correlated via the `log_comment` tag every query gets when enrichment is on (see
 * diag/logComment.ts / diag/enrichment.ts). This is the piece that actually answers "was it
 * ClickHouse or everything else" — see the diagnostics plan's Phase 2.
 *
 * `system.query_log` flushes asynchronously (`flush_interval_milliseconds`, default 7500ms), so a
 * lookup immediately after a query finishes usually finds nothing yet. `fetchServerStats` polls
 * with backoff instead of issuing `SYSTEM FLUSH LOGS` (privileged, cluster-wide — not something a
 * dashboard viewer's query should ever trigger).
 */
import { dateTime } from '@grafana/data';
import { SourceConfig } from '../types';
import { quoteIdentifier, quoteString } from '../sql/queryBuilder';
import { runQueryUntracedRows } from '../data/runQuery';
import { logCommentPrefixForTrace } from './logComment';

/**
 * The lookup's own WHERE clause is relative to `now()`, not the dashboard's time range — a
 * system.query_log lookup has nothing to do with what time window the user's logs search covered.
 * RunQueryOptions still requires *some* TimeRange (the CH datasource's request shape demands one),
 * so this synthesizes an unused-but-valid one rather than threading the dashboard's actual range
 * through App.tsx/autoEnrich.ts for a value that would never be read.
 */
function unusedTimeRange() {
  const now = dateTime();
  const from = dateTime().subtract(15, 'minute');
  return { from, to: now, raw: { from: 'now-15m', to: 'now' } };
}

export interface ServerStatsRow {
  spanId: string;
  queryId: string;
  type: string;
  queryDurationMs: number;
  readRows: number;
  readBytes: number;
  resultRows: number;
  memoryUsage: number;
  selectedMarks?: number;
  selectedParts?: number;
  selectedRanges?: number;
  osReadBytes?: number;
  exceptionCode?: number;
  exception?: string;
}

export type ServerStatsUnavailableReason = 'no-grant' | 'readonly' | 'error';

export type ServerStatsResult =
  | { status: 'ok'; rows: ServerStatsRow[] }
  /** Every poll attempt succeeded but returned zero rows — could be `log_queries = 0`, a
   *  `system.query_log` TTL shorter than the lookup window, or the flush genuinely hasn't happened
   *  yet. These are indistinguishable from a single client-side lookup, so this is reported as
   *  "nothing arrived," not as a specific diagnosis — see the module doc comment and the
   *  diagnostics plan's Phase 2 constraints. */
  | { status: 'no-data' }
  | { status: 'unavailable'; reason: ServerStatsUnavailableReason; detail: string };

const POLL_DELAYS_MS = [1000, 3000, 8000];

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

function buildServerStatsQuery(config: SourceConfig, traceId: string): string {
  const table = config.clusterName
    ? `clusterAllReplicas(${quoteIdentifier(config.clusterName)}, system.query_log)`
    : 'system.query_log';
  const prefix = logCommentPrefixForTrace(traceId);
  return [
    `SELECT`,
    `  splitByChar('|', log_comment)[3] AS span_id,`,
    `  query_id, type, query_duration_ms,`,
    `  read_rows, read_bytes, result_rows, memory_usage,`,
    `  ProfileEvents['SelectedMarks'] AS selected_marks,`,
    `  ProfileEvents['SelectedParts'] AS selected_parts,`,
    `  ProfileEvents['SelectedRanges'] AS selected_ranges,`,
    `  ProfileEvents['OSReadBytes'] AS os_read_bytes,`,
    `  exception_code, exception`,
    `FROM ${table}`,
    // event_date/event_time hit system.query_log's own PARTITION BY / sort-key prefix — this is
    // what keeps the lookup cheap; the log_comment match below is a scan of whatever survives.
    `WHERE event_date >= today() - 1`,
    `  AND event_time >= now() - INTERVAL 10 MINUTE`,
    `  AND log_comment != ''`,
    `  AND startsWith(log_comment, ${quoteString(prefix)})`,
    `  AND type IN ('QueryFinish', 'ExceptionWhileProcessing', 'ExceptionBeforeStart')`,
    `LIMIT 200`,
    `SETTINGS max_execution_time = 10,`,
    `         timeout_before_checking_execution_speed = 0,`,
    `         timeout_overflow_mode = 'throw',`,
    `         max_rows_to_read = 100000000,`,
    `         max_bytes_to_read = 10000000000`,
  ].join('\n');
}

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function parseRow(row: Record<string, unknown>): ServerStatsRow | null {
  const spanId = typeof row.span_id === 'string' && row.span_id ? row.span_id : null;
  if (!spanId) {
    return null;
  }
  const optionalNumber = (key: string): number | undefined => (row[key] != null ? toNumber(row[key]) : undefined);
  return {
    spanId,
    queryId: String(row.query_id ?? ''),
    type: String(row.type ?? ''),
    queryDurationMs: toNumber(row.query_duration_ms),
    readRows: toNumber(row.read_rows),
    readBytes: toNumber(row.read_bytes),
    resultRows: toNumber(row.result_rows),
    memoryUsage: toNumber(row.memory_usage),
    selectedMarks: optionalNumber('selected_marks'),
    selectedParts: optionalNumber('selected_parts'),
    selectedRanges: optionalNumber('selected_ranges'),
    osReadBytes: optionalNumber('os_read_bytes'),
    exceptionCode: optionalNumber('exception_code'),
    exception: typeof row.exception === 'string' && row.exception ? row.exception : undefined,
  };
}

/**
 * Best-effort classification of why the lookup itself failed. Regex-matched against the error
 * message text rather than a ClickHouse error code, since runQuery.ts's formatDataQueryError
 * already collapses whatever the datasource/proxy/ClickHouse layer produced into one string by
 * the time this sees it — there's no structured code left to switch on.
 */
function classifyError(message: string): ServerStatsUnavailableReason {
  const lower = message.toLowerCase();
  if (/readonly|read-only|read only/.test(lower)) {
    return 'readonly';
  }
  if (/not enough privileges|access denied|access_denied/.test(lower)) {
    return 'no-grant';
  }
  return 'error';
}

/**
 * Polls `system.query_log` for every query tagged under `traceId`, backing off across
 * POLL_DELAYS_MS to ride out the log's async flush. Resolves once real rows arrive, once polling
 * is exhausted with nothing, or immediately on a definite error (no retry — a permission/readonly
 * failure won't fix itself between attempts).
 */
export async function fetchServerStats(
  datasourceUid: string,
  config: SourceConfig,
  traceId: string,
  signal?: AbortSignal
): Promise<ServerStatsResult> {
  const sql = buildServerStatsQuery(config, traceId);
  for (const delay of POLL_DELAYS_MS) {
    try {
      await sleep(delay, signal);
    } catch {
      return { status: 'no-data' }; // aborted mid-wait — treat like "nothing arrived", not an error
    }
    try {
      const rows = await runQueryUntracedRows({
        datasourceUid,
        sql,
        timeRange: unusedTimeRange(),
        op: 'serverStatsLookup',
        signal,
      });
      const parsed = rows.map(parseRow).filter((r): r is ServerStatsRow => r !== null);
      if (parsed.length > 0) {
        return { status: 'ok', rows: parsed };
      }
      // Zero rows this attempt — keep polling; the flush may just not have happened yet.
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { status: 'no-data' };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { status: 'unavailable', reason: classifyError(message), detail: message };
    }
  }
  return { status: 'no-data' };
}
